//===----------------------------------------------------------------------===//
//
// This source file is part of the VS Code Swift open source project
//
// Copyright (c) 2024 the VS Code Swift project authors
// Licensed under Apache License v2.0
//
// See LICENSE.txt for license information
// See CONTRIBUTORS.txt for the list of VS Code Swift project authors
//
// SPDX-License-Identifier: Apache-2.0
//
//===----------------------------------------------------------------------===//

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
import stripAnsi = require("strip-ansi");
import configuration from "./configuration";
import { SwiftExecution } from "./tasks/SwiftExecution";
import { WorkspaceContext } from "./WorkspaceContext";
import { checkIfBuildComplete, lineBreakRegex } from "./utilities/tasks";
import { validFileTypes } from "./utilities/filesystem";

interface ParsedDiagnostic {
    uri: string;
    diagnostic: vscode.Diagnostic;
}

type DiagnosticsMap = Map<string, vscode.Diagnostic[]>;

type SourcePredicate = (source: string) => boolean;

type DiagnosticPredicate = (diagnostic: vscode.Diagnostic) => boolean;

const isEqual = (d1: vscode.Diagnostic, d2: vscode.Diagnostic) =>
    d1.range.start.isEqual(d2.range.start) && d1.message === d2.message;

const isSource = (diagnostic: vscode.Diagnostic, sourcesPredicate: SourcePredicate) =>
    sourcesPredicate(diagnostic.source ?? "");

const isSwiftc: DiagnosticPredicate = diagnostic =>
    isSource(diagnostic, DiagnosticsManager.isSwiftc);

const isSourceKit: DiagnosticPredicate = diagnostic =>
    isSource(diagnostic, DiagnosticsManager.isSourcekit);

/**
 * Handles the collection and deduplication of diagnostics from
 * various {@link vscode.Diagnostic.source | Diagnostic sources}.
 *
 * Listens for running {@link SwiftExecution} tasks and allows
 * external clients to call {@link handleDiagnostics} to provide
 * thier own diagnostics.
 */
export class DiagnosticsManager implements vscode.Disposable {
    private static swiftc: string = "swiftc";
    static isSourcekit: SourcePredicate = source => this.swiftc !== source;
    static isSwiftc: SourcePredicate = source => this.swiftc === source;

    private diagnosticCollection: vscode.DiagnosticCollection =
        vscode.languages.createDiagnosticCollection("swift");
    allDiagnostics: Map<string, vscode.Diagnostic[]> = new Map();
    private disposed = false;

    constructor(context: WorkspaceContext) {
        this.onDidChangeConfigurationDisposible = vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration("swift.diagnosticsCollection")) {
                this.diagnosticCollection.clear();
                this.allDiagnostics.forEach((_, uri) =>
                    this.updateDiagnosticsCollection(vscode.Uri.file(uri))
                );
            }
        });
        this.onDidStartTaskDisposible = vscode.tasks.onDidStartTask(event => {
            // Will only try to provide diagnostics for `swift` tasks
            const task = event.execution.task;
            if (task.definition.type !== "swift") {
                return;
            }
            if (!this.includeSwiftcDiagnostics()) {
                return;
            }
            // Provide new list of diagnostics
            const swiftExecution = task.execution as SwiftExecution;
            const provideDiagnostics: Promise<DiagnosticsMap> =
                this.parseDiagnostics(swiftExecution);

            provideDiagnostics
                .then(map => {
                    // Clean up old "swiftc" diagnostics
                    this.removeSwiftcDiagnostics();
                    map.forEach((diagnostics, uri) => {
                        this.handleDiagnostics(
                            vscode.Uri.file(uri),
                            DiagnosticsManager.isSwiftc,
                            diagnostics
                        );
                    });
                })
                .catch(e => context.logger.error(`Failed to provide "swiftc" diagnostics: ${e}`));
        });
        const fileTypes = validFileTypes.join(",");
        this.workspaceFileWatcher = vscode.workspace.createFileSystemWatcher(
            `**/*.{${fileTypes}}`,
            true,
            true
        );
        this.onDidDeleteDisposible = this.workspaceFileWatcher.onDidDelete(uri => {
            if (this.allDiagnostics.delete(uri.fsPath)) {
                this.diagnosticCollection.delete(uri);
            }
        });
    }

    /**
     * Provide a new list of diagnostics for a given file
     *
     * @param uri {@link vscode.Uri Uri} of the file these diagonstics apply to
     * @param sourcePredicate Diagnostics of a source that satisfies the predicate will apply for cleaning
     * up diagnostics that have been removed. See {@link isSwiftc} and {@link isSourceKit}
     * @param newDiagnostics Array of {@link vscode.Diagnostic}. This can be empty to remove old diagnostics satisfying `sourcePredicate`.
     */
    handleDiagnostics(
        uri: vscode.Uri,
        sourcePredicate: SourcePredicate,
        newDiagnostics: vscode.Diagnostic[]
    ): void {
        if (this.disposed) {
            return;
        }

        const isFromSourceKit = !sourcePredicate(DiagnosticsManager.swiftc);
        // Is a descrepency between SourceKit-LSP and older versions
        // of Swift as to whether the first letter is capitalized or not,
        // so we'll always display messages capitalized to user and this
        // also will allow comparing messages when merging
        newDiagnostics = newDiagnostics.map(this.capitalizeMessage).map(this.cleanMessage);
        const allDiagnostics = this.allDiagnostics.get(uri.fsPath)?.slice() || [];
        // Remove the old set of diagnostics from this source
        const removedDiagnostics = this.removeDiagnostics(allDiagnostics, d =>
            isSource(d, sourcePredicate)
        );
        // Clean up any "fixed" swiftc diagnostics
        if (isFromSourceKit) {
            this.removeDiagnostics(
                removedDiagnostics,
                d1 => !!newDiagnostics.find(d2 => isEqual(d1, d2))
            );
            this.removeDiagnostics(
                allDiagnostics,
                d1 => isSwiftc(d1) && !!removedDiagnostics.find(d2 => isEqual(d1, d2))
            );
        }

        for (const diagnostic of newDiagnostics) {
            if (
                diagnostic.code &&
                typeof diagnostic.code !== "string" &&
                typeof diagnostic.code !== "number"
            ) {
                const fsPath = diagnostic.code.target.fsPath;

                // Work around a bug in the nightlies where the URL comes back looking like:
                // `/path/to/TestPackage/https:/docs.swift.org/compiler/documentation/diagnostics/nominal-types`
                // Transform this in to a valid docs.swift.org URL which the openEducationalNote command
                // will open in a browser.
                // FIXME: This can be removed when the bug is fixed in sourcekit-lsp.
                let open = false;
                const needle = `https:${path.sep}docs.swift.org${path.sep}`;
                if (fsPath.indexOf(needle) !== -1) {
                    const extractedPath = `https://docs.swift.org/${fsPath.split(needle).pop()}/`;
                    diagnostic.code.target = vscode.Uri.parse(extractedPath.replace(/\\/g, "/"));
                    open = true;
                } else if (diagnostic.code.target.fsPath.endsWith(".md")) {
                    open = true;
                }

                if (open) {
                    diagnostic.code = {
                        target: vscode.Uri.parse(
                            `command:swift.openEducationalNote?${encodeURIComponent(JSON.stringify(diagnostic.code.target))}`
                        ),
                        value: "More Information...",
                    };
                }
            }
        }

        // Append the new diagnostics we just received
        allDiagnostics.push(...newDiagnostics);
        this.allDiagnostics.set(uri.fsPath, allDiagnostics);
        // Update the collection
        this.updateDiagnosticsCollection(uri);
    }

    private updateDiagnosticsCollection(uri: vscode.Uri): void {
        const diagnostics = this.allDiagnostics.get(uri.fsPath) ?? [];
        const swiftcDiagnostics = diagnostics.filter(isSwiftc);
        const sourceKitDiagnostics = diagnostics.filter(isSourceKit);
        const mergedDiagnostics: vscode.Diagnostic[] = [];
        switch (configuration.diagnosticsCollection) {
            case "keepSourceKit":
                mergedDiagnostics.push(...swiftcDiagnostics);
                this.mergeDiagnostics(mergedDiagnostics, sourceKitDiagnostics, isSourceKit);
                break;
            case "keepSwiftc":
                mergedDiagnostics.push(...sourceKitDiagnostics);
                this.mergeDiagnostics(mergedDiagnostics, swiftcDiagnostics, isSwiftc);
                break;
            case "onlySourceKit":
                mergedDiagnostics.push(...sourceKitDiagnostics);
                break;
            case "onlySwiftc":
                mergedDiagnostics.push(...swiftcDiagnostics);
                break;
            case "keepAll":
                mergedDiagnostics.push(...sourceKitDiagnostics);
                mergedDiagnostics.push(...swiftcDiagnostics);
                break;
        }
        this.diagnosticCollection.set(uri, mergedDiagnostics);
    }

    private mergeDiagnostics(
        mergedDiagnostics: vscode.Diagnostic[],
        newDiagnostics: vscode.Diagnostic[],
        precedencePredicate: DiagnosticPredicate
    ): void {
        for (const diagnostic of newDiagnostics) {
            // See if a duplicate diagnostic exists
            const currentDiagnostic = mergedDiagnostics.find(d => isEqual(d, diagnostic));
            if (currentDiagnostic) {
                mergedDiagnostics.splice(mergedDiagnostics.indexOf(currentDiagnostic), 1);
            }

            // Perform de-duplication
            if (precedencePredicate(diagnostic)) {
                mergedDiagnostics.push(diagnostic);
                continue;
            }
            if (!currentDiagnostic || !precedencePredicate(currentDiagnostic)) {
                mergedDiagnostics.push(diagnostic);
                continue;
            }
            mergedDiagnostics.push(currentDiagnostic);
        }
    }

    private removeSwiftcDiagnostics() {
        this.allDiagnostics.forEach((diagnostics, path) => {
            const newDiagnostics = diagnostics.slice();
            this.removeDiagnostics(newDiagnostics, isSwiftc);
            if (diagnostics.length !== newDiagnostics.length) {
                this.allDiagnostics.set(path, newDiagnostics);
            }
            this.updateDiagnosticsCollection(vscode.Uri.file(path));
        });
    }

    private removeDiagnostics(
        diagnostics: vscode.Diagnostic[],
        matches: DiagnosticPredicate
    ): vscode.Diagnostic[] {
        const removed: vscode.Diagnostic[] = [];
        let i = diagnostics.length;
        while (i--) {
            if (matches(diagnostics[i])) {
                removed.push(...diagnostics.splice(i, 1));
            }
        }
        return removed;
    }

    /**
     * Clear the `swift` diagnostics collection. Mostly meant for testing purposes.
     */
    clear(): void {
        this.diagnosticCollection.clear();
        this.allDiagnostics.clear();
    }

    dispose() {
        this.disposed = true;
        this.diagnosticCollection.dispose();
        this.onDidStartTaskDisposible.dispose();
        this.onDidChangeConfigurationDisposible.dispose();
        this.onDidDeleteDisposible.dispose();
        this.workspaceFileWatcher.dispose();
    }

    private includeSwiftcDiagnostics(): boolean {
        return configuration.diagnosticsCollection !== "onlySourceKit";
    }

    private parseDiagnostics(swiftExecution: SwiftExecution): Promise<DiagnosticsMap> {
        return new Promise<DiagnosticsMap>(res => {
            const diagnostics = new Map();
            const disposables: vscode.Disposable[] = [];
            const done = () => {
                disposables.forEach(d => d.dispose());
                res(diagnostics);
            };
            let remainingData: string | undefined;
            let lastDiagnostic: vscode.Diagnostic | undefined;
            let lastDiagnosticNeedsSaving = false;
            disposables.push(
                swiftExecution.onDidWrite(data => {
                    const sanitizedData = (remainingData || "") + stripAnsi(data);
                    const lines = sanitizedData.split(lineBreakRegex);
                    // If ends with \n then will be "" and there's no affect.
                    // Otherwise want to keep remaining data to pre-pend next write
                    remainingData = lines.pop();
                    for (const line of lines) {
                        if (checkIfBuildComplete(line)) {
                            done();
                            return;
                        }
                        const result = this.parseDiagnostic(line);
                        if (!result) {
                            continue;
                        }
                        if (result instanceof vscode.DiagnosticRelatedInformation) {
                            if (!lastDiagnostic) {
                                continue;
                            }
                            const relatedInformation =
                                result as vscode.DiagnosticRelatedInformation;
                            if (
                                lastDiagnostic.relatedInformation?.find(
                                    d =>
                                        d.message === relatedInformation.message &&
                                        d.location.uri.fsPath ===
                                            relatedInformation.location.uri.fsPath &&
                                        d.location.range.isEqual(relatedInformation.location.range)
                                )
                            ) {
                                // De-duplicate duplicate notes from SwiftPM
                                // TODO remove when https://github.com/apple/swift/issues/73973 is fixed
                                continue;
                            }
                            lastDiagnostic.relatedInformation = (
                                lastDiagnostic.relatedInformation || []
                            ).concat(relatedInformation);

                            if (lastDiagnosticNeedsSaving) {
                                const expandedUri = relatedInformation.location.uri.fsPath;
                                const currentUriDiagnostics = diagnostics.get(expandedUri) || [];
                                lastDiagnostic.range = relatedInformation.location.range;
                                diagnostics.set(expandedUri, [
                                    ...currentUriDiagnostics,
                                    lastDiagnostic,
                                ]);

                                lastDiagnosticNeedsSaving = false;
                            }
                            continue;
                        }
                        const { uri, diagnostic } = result as ParsedDiagnostic;

                        const currentUriDiagnostics: vscode.Diagnostic[] =
                            diagnostics.get(uri) || [];
                        if (
                            currentUriDiagnostics.find(
                                d =>
                                    d.message === diagnostic.message &&
                                    d.range.isEqual(diagnostic.range)
                            )
                        ) {
                            // De-duplicate duplicate diagnostics from SwiftPM
                            // TODO remove when https://github.com/apple/swift/issues/73973 is fixed
                            lastDiagnostic = undefined;
                            continue;
                        }
                        lastDiagnostic = diagnostic;

                        // If the diagnostic comes from a macro expansion the URI is going to be an invalid URI.
                        // Save the diagnostic for when we get the related information which has the macro expansion location
                        // that should be used as the correct URI.
                        if (this.isValidUri(uri)) {
                            diagnostics.set(uri, [...currentUriDiagnostics, diagnostic]);
                        } else {
                            lastDiagnosticNeedsSaving = true;
                        }
                    }
                }),
                swiftExecution.onDidClose(done)
            );
        });
    }

    private isValidUri(uri: string): boolean {
        try {
            fs.accessSync(uri, fs.constants.F_OK);
            return true;
        } catch {
            return false;
        }
    }

    private parseDiagnostic(
        line: string
    ): ParsedDiagnostic | vscode.DiagnosticRelatedInformation | undefined {
        const diagnosticRegex =
            /^(?:[`-\s]*)(.*?):(\d+)(?::(\d+))?:\s+(warning|error|note):\s+(.*)$/g;
        const switfcExtraWarningsRegex = /\[(-W|#).*?\]/g;
        const match = diagnosticRegex.exec(line);
        if (!match) {
            return;
        }
        const uri = vscode.Uri.file(match[1]).fsPath;
        const message = this.capitalize(match[5]).replace(switfcExtraWarningsRegex, "").trim();
        const range = this.range(match[2], match[3]);
        const severity = this.severity(match[4]);
        if (severity === vscode.DiagnosticSeverity.Information) {
            return new vscode.DiagnosticRelatedInformation(
                new vscode.Location(vscode.Uri.file(uri), range),
                message
            );
        }
        const diagnostic = new vscode.Diagnostic(range, message, severity);
        diagnostic.source = DiagnosticsManager.swiftc;
        return { uri, diagnostic };
    }

    private range(lineString: string, columnString: string): vscode.Range {
        // Output from `swift` is 1-based but vscode expects 0-based lines and columns
        const line = parseInt(lineString) - 1;
        const col = parseInt(columnString) - 1;
        const position = new vscode.Position(line, col);
        return new vscode.Range(position, position);
    }

    private severity(severityString: string): vscode.DiagnosticSeverity {
        let severity = vscode.DiagnosticSeverity.Error;
        switch (severityString) {
            case "warning":
                severity = vscode.DiagnosticSeverity.Warning;
                break;
            case "note":
                severity = vscode.DiagnosticSeverity.Information;
                break;
            default:
                break;
        }
        return severity;
    }

    private capitalize(message: string): string {
        return message.charAt(0).toUpperCase() + message.slice(1);
    }

    private capitalizeMessage = (diagnostic: vscode.Diagnostic): vscode.Diagnostic => {
        const message = diagnostic.message;
        diagnostic = { ...diagnostic };
        diagnostic.message = this.capitalize(message);
        return diagnostic;
    };

    private cleanMessage = (diagnostic: vscode.Diagnostic) => {
        diagnostic = { ...diagnostic };
        diagnostic.message = diagnostic.message.replace("(fix available)", "").trim();
        return diagnostic;
    };

    private onDidStartTaskDisposible: vscode.Disposable;
    private onDidChangeConfigurationDisposible: vscode.Disposable;
    private onDidDeleteDisposible: vscode.Disposable;
    private workspaceFileWatcher: vscode.FileSystemWatcher;
}
