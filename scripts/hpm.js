"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const commander_1 = require("commander");
const path_1 = __importDefault(require("path"));
const promises_1 = require("fs/promises");
const fs_1 = __importStar(require("fs"));
const child_process_1 = require("child_process");
const crypto_1 = __importDefault(require("crypto"));
const package_json = JSON.parse((0, fs_1.readFileSync)('./package.json').toString());
const debug = process.env.HPM_DEBUG;
const program = new commander_1.Command();
const pluginDirAbsolutePath = path_1.default.join(path_1.default.resolve(), 'plugins', 'repos');
const pluginStatePath = path_1.default.join(path_1.default.resolve(), 'plugins', '.state.json');
let stateJson;
const ignoredDirsForHash = ['.git', 'node_modules'];
program.version(package_json.version);
function checkUrl(value) {
    if (value.startsWith('https://') || value.startsWith('git@')) {
        return value;
    }
    else {
        throw new commander_1.InvalidArgumentError('Invalid url.');
    }
}
function throwAndQuit(message) {
    console.error('⚠ >>', message);
    process.exit(1);
}
function getCurrentBranch(dir) {
    const gitCmd = `(cd ${dir} && git rev-parse --abbrev-ref HEAD)`;
    if (debug) {
        console.log(` >> ${gitCmd}`);
    }
    return (0, child_process_1.execSync)(gitCmd).toString().trim();
}
function checkoutBranch(dir, branchName) {
    const gitCmd = `(cd ${dir} && git checkout ${branchName})`;
    if (debug) {
        console.log(` >> ${gitCmd}`);
    }
    return (0, child_process_1.execSync)(gitCmd).toString();
}
function gitPull(dir) {
    const gitCmd = `(cd ${dir} && git pull)`;
    if (debug) {
        console.log(` >> ${gitCmd}`);
    }
    return (0, child_process_1.execSync)(gitCmd).toString();
}
function gitReset(dir) {
    const gitCmd = `(cd ${dir} && git reset --hard)`;
    if (debug) {
        console.log(` >> ${gitCmd}`);
    }
    return (0, child_process_1.execSync)(gitCmd).toString();
}
async function buildPlugin(name, flags) {
    const pluginDir = path_1.default.join(pluginDirAbsolutePath, name);
    if (!(0, fs_1.existsSync)(pluginDir)) {
        throwAndQuit(`plugin ${name} not found!`);
    }
    const currentBranch = getCurrentBranch(pluginDir);
    console.log(`-------- ⚒ ${name} @ ${currentBranch} -----------`);
    if (!flags.skipInstall) {
        // run npm install
        await new Promise(resolve => {
            const npmInstall = (0, child_process_1.spawn)('npm', ['install'], {
                cwd: pluginDir,
                stdio: 'inherit',
            });
            npmInstall.on('close', (code) => {
                if (code !== 0) {
                    console.log(`process exited with code ${code}`);
                    process.exit(code);
                }
                resolve(true);
            });
        });
    }
    // typescript build
    await new Promise(resolve => {
        const npmInstall = (0, child_process_1.spawn)('npm', ['run', 'build'], {
            cwd: pluginDir,
            stdio: 'inherit',
        });
        npmInstall.on('close', (code) => {
            if (code !== 0) {
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
async function verifyInstalledPlugin(pluginName, options) {
    const dir = path_1.default.join(pluginDirAbsolutePath, pluginName);
    const dirExists = (0, fs_1.existsSync)(dir);
    if (dirExists) {
        if (options.branch && options.branch !== '') {
            const currentBranch = getCurrentBranch(dir);
            if (currentBranch === options.branch) {
                console.log('✅ Plugin already installed, branch check OK');
                process.exit(0);
            }
            else {
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
async function hashItem(item) {
    if (fs_1.default.lstatSync(item).isDirectory()) {
        const dir = fs_1.default.readdirSync(item);
        const sha = crypto_1.default.createHash('sha1');
        for (const file of dir) {
            if (ignoredDirsForHash.includes(file) && fs_1.default.lstatSync(path_1.default.join(item, file)).isDirectory()) {
                sha.update('');
            }
            else {
                const hash = await hashItem(path_1.default.join(item, file));
                sha.update(hash.toString());
            }
        }
        return sha.digest('hex');
    }
    else {
        const sha = crypto_1.default.createHash('sha1');
        const reader = fs_1.default.createReadStream(item);
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
async function verifyInstallation(installPath, pluginName, opts) {
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
        const installedFiles = fs_1.default.readdirSync(installPath);
        if (!installedFiles.includes('package.json')) {
            console.log('package.json not found!');
            process.exit(0);
        }
    }
}
async function clonePluginRepo(pluginName, options) {
    const dir = path_1.default.join(pluginDirAbsolutePath, pluginName);
    await new Promise((resolve, reject) => {
        const gitClone = (0, child_process_1.spawn)('git', ['clone', options.repository, dir]);
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
    const check = (0, fs_1.existsSync)(pluginStatePath);
    if (check) {
        try {
            stateJson = JSON.parse((0, fs_1.readFileSync)(pluginStatePath).toString());
        }
        catch (e) {
            console.log(e);
        }
    }
    else {
        console.log('Creating new state file...');
        stateJson = {
            update_ts: Date.now(),
            hyperion_version: package_json.version,
            plugins: {}
        };
        (0, fs_1.writeFileSync)(pluginStatePath, JSON.stringify(stateJson, null, 2));
    }
}
async function installPlugin(plugin, options) {
    console.log(`Plugin Name: ${plugin}`);
    console.log(`Repository Url: ${options.repository}`);
    if (options.branch) {
        console.log(`Branch Name: ${options.branch}`);
    }
    // check installation
    await verifyInstalledPlugin(plugin, options);
    if (stateJson && stateJson.plugins) {
        stateJson.plugins[plugin] = {};
    }
    else {
        throwAndQuit('fatal error on state');
    }
    // clone repository
    await clonePluginRepo(plugin, options);
    // checkout branch
    if (options.branch) {
        const dir = path_1.default.join(pluginDirAbsolutePath, plugin);
        const results = checkoutBranch(dir, options.branch);
        stateJson.plugins[plugin].branch = options.branch;
        console.log(results);
    }
    // build plugin
    await buildPlugin(plugin, {
        skipInstall: false
    });
}
async function uninstall(plugin) {
    const pluginDir = path_1.default.join(pluginDirAbsolutePath, plugin);
    try {
        if (!(0, fs_1.existsSync)(pluginDir)) {
            throwAndQuit(`plugin ${plugin} not found!`);
        }
        console.log(`Removing ${pluginDir}...`);
        await (0, promises_1.rm)(pluginDir, {
            recursive: true
        });
        if (stateJson && stateJson.plugins) {
            delete stateJson.plugins[plugin];
            saveState();
        }
        console.log(`${plugin} removed!`);
    }
    catch (e) {
        throwAndQuit(e.message);
    }
}
async function listPlugins() {
    const dirs = await (0, promises_1.readdir)(pluginDirAbsolutePath);
    const results = [];
    for (const dir of dirs) {
        try {
            const packageJsonPath = path_1.default.join(pluginDirAbsolutePath, dir, 'package.json');
            const package_json = JSON.parse((0, fs_1.readFileSync)(packageJsonPath).toString());
            const { name, version, description } = package_json;
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
        }
        catch (e) {
            console.log(e.message);
        }
    }
    results.sort((a, b) => b.ative - a.ative);
    console.table(results);
}
function saveState() {
    stateJson.update_ts = Date.now();
    (0, fs_1.writeFileSync)(pluginStatePath, JSON.stringify(stateJson, null, 2));
}
async function setPluginState(pluginName, newState) {
    if (stateJson) {
        if (stateJson.plugins[pluginName]) {
            stateJson.plugins[pluginName].enabled = newState;
        }
        else {
            stateJson.plugins[pluginName] = {
                enabled: newState
            };
        }
    }
    saveState();
    console.log(`[${pluginName}] plugin ${newState ? 'enabled' : 'disabled'} successfully!`);
}
function enablePlugin(pluginName) {
    return setPluginState(pluginName, true);
}
function disablePlugin(pluginName) {
    return setPluginState(pluginName, false);
}
function printState() {
    console.log(JSON.stringify(stateJson, null, 2));
}
async function buildAllPlugins(flags) {
    const names = (0, fs_1.readdirSync)(pluginDirAbsolutePath);
    for (const name of names) {
        await buildPlugin(name, flags);
    }
}
async function updatePlugin(name) {
    const pluginDir = path_1.default.join(pluginDirAbsolutePath, name);
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
//# sourceMappingURL=hpm.js.map