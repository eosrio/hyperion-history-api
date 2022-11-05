import {Command, InvalidArgumentError} from 'commander';
import path from 'node:path'
import {readdir, rm} from "node:fs/promises";
import fs, {existsSync, readdirSync, readFileSync, writeFileSync} from "node:fs";
import {execSync, spawn} from "node:child_process";
import crypto from "node:crypto";

const package_json = JSON.parse(readFileSync('./package.json').toString());
const debug = process.env.HPM_DEBUG;
const program = new Command();
const pluginDirAbsolutePath = path.join(path.resolve(), 'plugins', 'repos');
const pluginStatePath = path.join(path.resolve(), 'plugins', '.state.json');

let stateJson: any;

const ignoredDirsForHash = ['.git', 'node_modules'];

program.version(package_json.version);

function checkUrl(value: string) {
    if (value.startsWith('https://') || value.startsWith('git@')) {
        return value;
    } else {
        throw new InvalidArgumentError('Invalid url.');
    }
}

function throwAndQuit(message: string) {
    console.error('⚠ >>', message);
    process.exit(1);
}

function getCurrentBranch(dir: string): string {
    const gitCmd = `(cd ${dir} && git rev-parse --abbrev-ref HEAD)`;
    if (debug) {
        console.log(` >> ${gitCmd}`);
    }
    return execSync(gitCmd).toString().trim();
}

function checkoutBranch(dir: string, branchName: string): string {
    const gitCmd = `(cd ${dir} && git checkout ${branchName})`;
    if (debug) {
        console.log(` >> ${gitCmd}`);
    }
    return execSync(gitCmd).toString();
}

function gitPull(dir: string): string {
    const gitCmd = `(cd ${dir} && git pull)`;
    if (debug) {
        console.log(` >> ${gitCmd}`);
    }
    return execSync(gitCmd).toString();
}

function gitReset(dir: string): string {
    const gitCmd = `(cd ${dir} && git reset --hard)`;
    if (debug) {
        console.log(` >> ${gitCmd}`);
    }
    return execSync(gitCmd).toString();
}

async function buildPlugin(name: string, flags: {
    skipInstall?: boolean
}) {

    const pluginDir = path.join(pluginDirAbsolutePath, name);

    if (!existsSync(pluginDir)) {
        throwAndQuit(`plugin ${name} not found!`);
    }

    const currentBranch = getCurrentBranch(pluginDir);

    console.log(`-------- ⚒ ${name} @ ${currentBranch} -----------`);

    if (!flags.skipInstall) {
        // run npm install
        await new Promise(resolve => {
            const npmInstall = spawn('npm', ['install'], {
                cwd: pluginDir,
                stdio: 'inherit',
            });
            npmInstall.on('close', (code) => {
                if (code && code !== 0) {
                    console.log(`process exited with code ${code}`);
                    process.exit(code);
                }
                resolve(true);
            });
        });
    }

    // typescript build
    await new Promise(resolve => {
        const npmInstall = spawn('npm', ['run', 'build'], {
            cwd: pluginDir,
            stdio: 'inherit',
        });
        npmInstall.on('close', (code) => {
            if (code && code !== 0) {
                console.log(`process exited with code ${code}`);
                process.exit(code);
            }
            resolve(true);
        });
    });

    console.log('-------------------------------');

    // save build date
    if (stateJson) {

        if (!stateJson.plugins[name]) {
            stateJson.plugins[name] = {};
        }

        stateJson.plugins[name].last_build_date = new Date().toISOString();
        const hash = await hashItem(pluginDir);
        console.log(`SHA1 Hash: ${hash}`);
        stateJson.plugins[name].hash = hash;
        stateJson.plugins[name].branch = currentBranch;
        saveState();
    }
}

async function verifyInstalledPlugin(pluginName: string, options: any): Promise<void> {
    const dir = path.join(pluginDirAbsolutePath, pluginName);
    const dirExists = existsSync(dir);
    if (dirExists) {
        if (options.branch && options.branch !== '') {
            const currentBranch = getCurrentBranch(dir);
            if (currentBranch === options.branch) {
                console.log('✅ Plugin already installed, branch check OK');
                process.exit(0);
            } else {
                // checkout new branch
                const checkoutResults = checkoutBranch(dir, options.branch);
                console.log(checkoutResults);
                console.log('done!');
                process.exit(0);
            }
        }
        throwAndQuit('plugin already installed');
    }
}

async function hashItem(item: string): Promise<string> {
    if (fs.lstatSync(item).isDirectory()) {
        const dir = fs.readdirSync(item);
        const sha = crypto.createHash('sha1');
        for (const file of dir) {
            if (ignoredDirsForHash.includes(file) && fs.lstatSync(path.join(item, file)).isDirectory()) {
                sha.update('');
            } else {
                const hash = await hashItem(path.join(item, file));
                sha.update(hash.toString());
            }
        }
        return sha.digest('hex');
    } else {
        const sha = crypto.createHash('sha1');
        const reader = fs.createReadStream(item);
        return new Promise(resolve => {
            reader.on('data', chunk => {
                sha.update(chunk);
            });
            reader.on('close', () => {
                resolve(sha.digest('hex'));
            });
        });
    }
}

async function verifyInstallation(installPath: string, pluginName: string, opts: {
    skipValidation: boolean
}) {
    console.log('Verifying integrity...');
    const hash = await hashItem(installPath);
    console.log(`SHA1 Hash: ${hash}`);

    if (stateJson && stateJson.plugins) {
        stateJson.plugins[pluginName].hash = hash;
        saveState();
    }

    if (!opts.skipValidation) {

        // if (hash !== data['integrityHash']) {
        //     console.log('WARNING! Integrity hash dos not match!');
        //     console.log(`Expected:\t${data['integrityHash']}`);
        //     console.log(`Current:\t${hash}`);
        //     process.exit(0);
        // }

        const installedFiles = fs.readdirSync(installPath);
        if (!installedFiles.includes('package.json')) {
            console.log('package.json not found!');
            process.exit(0);
        }
    }
}

async function clonePluginRepo(pluginName: string, options: any): Promise<void> {
    const dir = path.join(pluginDirAbsolutePath, pluginName);
    await new Promise<void>((resolve, reject) => {
        const gitClone = spawn('git', ['clone', options.repository, dir]);
        gitClone.stdout.on('data', chunk => {
            console.log(`->> ${chunk}`);
        });
        gitClone.stderr.on('data', chunk => {
            console.log(`->> ${chunk}`);
        });
        gitClone.on('close', (code) => {
            if (code !== 0) {
                console.log(`process exited with code ${code}`);
            }
            verifyInstallation(dir, pluginName, options)
                .then(() => {
                    resolve();
                })
                .catch((err) => {
                    throwAndQuit(err.message);
                    reject();
                });
        });
    });
}

function init() {
    const check = existsSync(pluginStatePath);
    if (check) {
        try {
            stateJson = JSON.parse(readFileSync(pluginStatePath).toString());
        } catch (e: any) {
            console.log(e);
        }
    } else {
        console.log('Creating new state file...');
        stateJson = {
            update_ts: Date.now(),
            hyperion_version: package_json.version,
            plugins: {}
        };
        writeFileSync(pluginStatePath, JSON.stringify(stateJson, null, 2));
    }
}

async function installPlugin(plugin: string, options: any) {
    console.log(`Plugin Name: ${plugin}`);
    console.log(`Repository Url: ${options.repository}`);

    if (options.branch) {
        console.log(`Branch Name: ${options.branch}`);
    }

    // check installation
    await verifyInstalledPlugin(plugin, options);

    if (stateJson && stateJson.plugins) {
        stateJson.plugins[plugin] = {};
    } else {
        throwAndQuit('fatal error on state');
    }

    // clone repository
    await clonePluginRepo(plugin, options);

    // checkout branch
    if (options.branch) {
        const dir = path.join(pluginDirAbsolutePath, plugin);
        const results = checkoutBranch(dir, options.branch);
        stateJson.plugins[plugin].branch = options.branch;
        console.log(results);
    }

    // build plugin
    await buildPlugin(plugin, {
        skipInstall: false
    });
}

async function uninstall(plugin: string) {
    const pluginDir = path.join(pluginDirAbsolutePath, plugin);
    try {
        if (!existsSync(pluginDir)) {
            throwAndQuit(`plugin ${plugin} not found!`);
        }
        console.log(`Removing ${pluginDir}...`);
        await rm(pluginDir, {
            recursive: true
        });
        if (stateJson && stateJson.plugins) {
            delete stateJson.plugins[plugin];
            saveState();
        }
        console.log(`${plugin} removed!`);
    } catch (e: any) {
        throwAndQuit(e.message);
    }
}

async function listPlugins() {
    const dirs = await readdir(pluginDirAbsolutePath);
    const results: any[] = [];
    for (const dir of dirs) {
        try {
            const packageJsonPath = path.join(pluginDirAbsolutePath, dir, 'package.json');
            const package_json = JSON.parse(readFileSync(packageJsonPath).toString());
            const {name, version, description} = package_json;
            // console.table([dir, name, version, description].join('\t'));

            let pluginState = false;
            let branch = '';

            if (stateJson.plugins && stateJson.plugins[dir]) {
                if (stateJson.plugins[dir].enabled) {
                    pluginState = true;
                }
                branch = stateJson.plugins[dir].branch;
            }

            results.push({
                alias: dir,
                enabled: pluginState,
                plugin_name: name,
                version,
                branch,
                description
            });
        } catch (e: any) {
            console.log(e.message);
        }
    }
    results.sort((a, b) => b.ative - a.ative);
    console.table(results);
}

function saveState() {
    stateJson.update_ts = Date.now();
    writeFileSync(pluginStatePath, JSON.stringify(stateJson, null, 2));
}

async function setPluginState(pluginName: string, newState: boolean) {
    if (stateJson) {
        if (stateJson.plugins[pluginName]) {
            stateJson.plugins[pluginName].enabled = newState;
        } else {
            stateJson.plugins[pluginName] = {
                enabled: newState
            }
        }
    }
    saveState();
    console.log(`[${pluginName}] plugin ${newState ? 'enabled' : 'disabled'} successfully!`);
}

function enablePlugin(pluginName: string) {
    return setPluginState(pluginName, true);
}

function disablePlugin(pluginName: string) {
    return setPluginState(pluginName, false);
}

function printState() {
    console.log(JSON.stringify(stateJson, null, 2));
}

async function buildAllPlugins(flags: any) {
    const names = readdirSync(pluginDirAbsolutePath);
    for (const name of names) {
        await buildPlugin(name, flags)
    }
}

async function updatePlugin(name: string) {
    const pluginDir = path.join(pluginDirAbsolutePath, name);
    const resetStatus = gitReset(pluginDir);
    console.log(resetStatus);
    const pullStatus = gitPull(pluginDir);
    console.log(pullStatus);
    await buildPlugin(name, {});
}

(() => {

    init();

    program.description('Command-line utility to manage Hyperion plugins\nMade with ♥  by EOS Rio');

    program.command('install <plugin>').alias('i')
        .description('install new plugin')
        .option('-r, --repository <url>', 'custom repository url', checkUrl)
        .option('-b, --branch <branch>', 'checkout specific branch')
        .option('-s, --skip-validation', 'skip plugin integrity validation')
        .action(installPlugin);

    program.command('enable <plugin>')
        .description('enable plugin')
        .action(enablePlugin);

    program.command('disable <plugin>')
        .description('disable plugin')
        .action(disablePlugin);

    program.command('state')
        .description('print current state file')
        .action(printState);

    program.command('list').alias('ls')
        .description('list installed plugins')
        .action(listPlugins);

    program.command('build <plugin>').alias('b')
        .description('build a single plugin')
        .option('-s, --skip-install', 'skip "npm install" step')
        .action(buildPlugin);

    program.command('update <plugin>')
        .description('update a single plugin')
        .action(updatePlugin);

    program.command('build-all')
        .description('build all plugins')
        .option('-s, --skip-install', 'skip "npm install" step')
        .action(buildAllPlugins);

    program.command('uninstall <plugin>').alias('rm')
        .description('uninstall plugin')
        .action(uninstall);

    program.parse();
})();
