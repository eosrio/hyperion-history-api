const fs = require('fs');
const got = require('got');
const path = require('path');
const readline = require('readline');
const {spawn} = require('child_process');
const crypto = require('crypto');

const command = process.argv[2];
const pluginName = process.argv[3];

const flags = [];
process.argv.forEach(value => {
  if (value.startsWith('--')) {
    flags.push(value.slice(2));
  }
});

if (command === 'install') {
  if (!pluginName) {
    console.log('Please inform a plugin name!\n"npm run plugin-manager install PLUGIN_NAME"');
    console.log('Exiting now!');
    process.exit(0);
  }
}

console.log(`Hyperion Plugin Manager`);
console.log(`>> ${command} ${pluginName}`);

let catalog;

async function hashItem(item) {
  if (fs.lstatSync(item).isDirectory()) {
    const dir = fs.readdirSync(item);
    const sha = crypto.createHash('sha1');
    for (const file of dir) {
      if (file === '.git' && fs.lstatSync(path.join(item, file)).isDirectory()) {
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

async function verifyInstallation(data) {
  console.log('Verifying integrity...');
  const hash = await hashItem(data.installPath);
  console.log(`SHA1 Hash: ${hash}`);
  if (!flags.includes('skip-validation')) {
    if (hash !== data['integrityHash']) {
      console.log('WARNING! Integrity hash dos not match!');
      console.log(`Expected:\t${data['integrityHash']}`);
      console.log(`Current:\t${hash}`);
      process.exit(0);
    }
    const installedFiles = fs.readdirSync(data.installPath);
    if (!installedFiles.includes('package.json')) {
      console.log('package.json not found!');
      process.exit(0);
    }
  }
}

function startInstallation(data) {
  const installPath = path.join(__dirname, 'repos', data.name);
  data['installPath'] = installPath;
  let clone = false;
  if (fs.existsSync(installPath)) {
    if (flags.includes('reinstall')) {
      console.log('Removing installed plugin...');
      fs.rmdirSync(installPath, {recursive: true});
      clone = true;
    }
  } else {
    clone = true;
  }

  if (clone) {
    const gitClone = spawn('git', ['clone', data['repo'], installPath]);
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
      verifyInstallation(data).catch(console.log);
    });
  } else {
    verifyInstallation(data).catch(console.log);
  }
}

async function installCommand() {
  const cachedCatalogPath = path.join(__dirname, 'catalog.cache');
  if (fs.existsSync(cachedCatalogPath)) {
    const cachedCatalogStat = fs.statSync(cachedCatalogPath);
    if (Date.now() - cachedCatalogStat.ctimeMs < (60 * 60 * 1000)) {
      catalog = JSON.parse(fs.readFileSync(cachedCatalogPath).toString());
    }
  }

  if (flags.includes('ignore-cache')) {
    console.log(`Ignoring current catalog cache!`);
    catalog = null;
  }

  if (!catalog) {
    // update catalog
    console.log(`Updating catalog...`);
    catalog = await got.get('https://raw.githubusercontent.com/eosrio/hyperion-plugins/main/catalog.json').json();
    if (!catalog) {
      console.log('Error loading catalog!');
      process.exit(1);
    }
    fs.writeFileSync(cachedCatalogPath, JSON.stringify(catalog));
  }

  const pluginData = catalog.plugins.find((p) => {
    return p.name === pluginName;
  });
  if (pluginData) {

    console.log(`Plugin found!`);
    console.log(`  Description:\t${pluginData['desc']}`);
    console.log(`  Version:\t${pluginData['tag']}`);
    console.log(`  Repository:\t${pluginData['repo']}`);

    const rl = readline.createInterface({input: process.stdin, output: process.stdout});

    // confirm installation
    rl.question(`Confirm installation of ${pluginData.name} ${pluginData.tag}? [Y/n] (default=Y) `, answer => {
      if (!answer || answer.toUpperCase() === 'Y') {
        console.log('Downloading plugin...');
        startInstallation(pluginData);
      } else {
        console.log('Aborted!');
      }
      rl.close();
    });

  } else {
    console.log(`Plugin "${pluginName}" not found!`);
    console.log('Similar results:');
    for (const plugin of catalog.plugins) {
      if (plugin.name.startsWith(pluginName.slice(0, 2))) {
        console.log(`\t - ${plugin.name}\n\t\t${plugin.desc}\n`);
      }
    }
  }
}

async function buildPlugin(path, name) {
  console.log(`-------- ⚒ ${name} -----------`);

  // run npm install
  await new Promise(resolve => {
    const npmInstall = spawn('npm', ['install'], {
      cwd: path,
      stdio: 'inherit',
    });
    npmInstall.on('close', (code) => {
      if (code !== 0) {
        console.log(`process exited with code ${code}`);
      }
      resolve(true);
    });
  });

  // typescript build
  await new Promise(resolve => {
    const npmInstall = spawn('npm', ['run', 'build'], {
      cwd: path,
      stdio: 'inherit',
    });
    npmInstall.on('close', (code) => {
      if (code !== 0) {
        console.log(`process exited with code ${code}`);
      }
      resolve(true);
    });
  });

  console.log('-------------------------------');
}

async function buildAllCommand() {
  const installPath = path.join(__dirname, 'repos');
  const installedPlugins = fs.readdirSync(installPath);
  for (const pluginDir of installedPlugins) {
    await buildPlugin(path.join(installPath, pluginDir), pluginDir);
  }
}

(async () => {
  switch (command) {
    case 'install': {
      await installCommand();
      break;
    }
    case 'build-all': {
      await buildAllCommand();
      console.log('Build All completed!');
      break;
    }
    default: {
      console.log(`Unknown command: ${command}. Exiting now!`);
      process.exit(1);
    }
  }
})();
