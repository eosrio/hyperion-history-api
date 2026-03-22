/**
 * ExplorerRunner — Manages the hyperion-explorer build, serve, and test lifecycle
 * for E2E testing.
 *
 * Expects the explorer to be cloned alongside the hyperion-history-api repo:
 *   ../hyperion-explorer/
 *
 * Port convention: 14210 (4210 + 10000)
 */

import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface ExplorerRunnerOptions {
    /** Absolute path to the explorer repo root */
    explorerRoot: string;
    /** Port for the static file server (default: 14210) */
    port?: number;
    /** URL of the Hyperion API the explorer will connect to */
    apiUrl?: string;
    /** Print verbose output */
    verbose?: boolean;
}

export class ExplorerRunner {
    private readonly explorerRoot: string;
    private readonly port: number;
    private readonly apiUrl: string;
    private readonly verbose: boolean;
    private serverProcess: ChildProcess | null = null;

    constructor(opts: ExplorerRunnerOptions) {
        this.explorerRoot = resolve(opts.explorerRoot);
        this.port = opts.port ?? 14210;
        this.apiUrl = opts.apiUrl ?? 'http://127.0.0.1:17000';
        this.verbose = opts.verbose ?? false;

        if (!existsSync(this.explorerRoot)) {
            throw new Error(`Explorer directory not found: ${this.explorerRoot}`);
        }

        if (!existsSync(join(this.explorerRoot, 'angular.json'))) {
            throw new Error(`Not an Angular project: ${this.explorerRoot} (no angular.json)`);
        }
    }

    /** Install dependencies if needed */
    install(): void {
        this.log('📦 Installing explorer dependencies...');
        const lockFile = join(this.explorerRoot, 'bun.lock');
        const nodeModules = join(this.explorerRoot, 'node_modules');

        if (!existsSync(nodeModules) || !existsSync(lockFile)) {
            execSync('bun install', {
                cwd: this.explorerRoot,
                stdio: this.verbose ? 'inherit' : 'pipe',
                timeout: 120_000,
            });
            this.log('   ✅ Dependencies installed');
        } else {
            this.log('   ✅ Dependencies already installed');
        }
    }

    /** Build the explorer with the e2e configuration */
    build(): void {
        this.log('🔨 Building explorer with e2e configuration...');
        execSync('bun run ng build --configuration=e2e', {
            cwd: this.explorerRoot,
            stdio: this.verbose ? 'inherit' : 'pipe',
            timeout: 120_000,
            env: { ...process.env },
        });
        this.log('   ✅ Explorer built successfully');
    }

    /** Serve the built explorer using the Angular SSR server */
    async serve(): Promise<void> {
        const serverEntry = this.findServerEntry();
        if (!serverEntry) {
            throw new Error('Explorer server entry not found. Run build first.');
        }

        this.log(`🌐 Starting Angular SSR server from ${serverEntry} on port ${this.port}...`);

        this.serverProcess = spawn('node', [serverEntry], {
            cwd: join(this.explorerRoot, 'dist', 'hyperion-explorer'),
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false,
            env: {
                ...process.env,
                HYP_EXPLORER_PORT: String(this.port),
                HYP_API_URL: this.apiUrl,
            },
        });

        // Wait for server to be ready by polling
        await new Promise<void>((resolveP, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Explorer SSR server did not start within 15s'));
            }, 15_000);

            this.serverProcess!.stderr?.on('data', (data: Buffer) => {
                if (this.verbose) process.stderr.write(data.toString());
            });

            this.serverProcess!.stdout?.on('data', (data: Buffer) => {
                if (this.verbose) process.stdout.write(data.toString());
            });

            this.serverProcess!.on('error', (err) => {
                clearInterval(poll);
                clearTimeout(timeout);
                reject(err);
            });

            // Detect early crashes (bad imports, port collision, etc.)
            this.serverProcess!.on('exit', (code) => {
                if (code !== 0 && code !== null) {
                    clearInterval(poll);
                    clearTimeout(timeout);
                    reject(new Error(`Explorer SSR server exited unexpectedly with code ${code}`));
                }
            });

            // Poll until the server responds
            const poll = setInterval(async () => {
                try {
                    const resp = await fetch(`http://127.0.0.1:${this.port}/`);
                    if (resp.ok || resp.status < 500) {
                        clearInterval(poll);
                        clearTimeout(timeout);
                        resolveP();
                    }
                } catch {
                    // Server not ready yet
                }
            }, 500);
        });

        this.log(`   ✅ Explorer SSR serving at http://127.0.0.1:${this.port}`);
    }

    /** Stop the SSR server */
    stop(): void {
        if (this.serverProcess) {
            this.serverProcess.kill('SIGTERM');
            this.serverProcess = null;
            this.log('   ✅ Explorer server stopped');
        }
    }

    /** Find the Angular SSR server entry point */
    private findServerEntry(): string | null {
        const candidates = [
            join(this.explorerRoot, 'dist', 'hyperion-explorer', 'server', 'server.mjs'),
        ];
        for (const entry of candidates) {
            if (existsSync(entry)) {
                return entry;
            }
        }
        return null;
    }

    /** Get the base URL for the explorer */
    getBaseUrl(): string {
        return `http://127.0.0.1:${this.port}`;
    }

    private log(msg: string): void {
        if (this.verbose) {
            console.log(msg);
        }
    }
}
