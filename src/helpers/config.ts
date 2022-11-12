import {HyperionConfig} from "../interfaces/hyperionConfig.js";
import {existsSync, readdirSync, readFileSync, PathLike} from "node:fs";
import {join, resolve} from "node:path";
import {hLog} from "./common_functions.js";

export function getChainConfig(): HyperionConfig {
    let config: HyperionConfig | undefined;
    let confPath = process.env.CONFIG_JSON as PathLike;
    if (!confPath) {
        const chainsDirPath = resolve('config', 'chains');
        if (!existsSync(chainsDirPath)) {
            hLog(`[FATAL] Chains directory is not present at: ${chainsDirPath}`);
            process.exit(1);
        }
        const chainFiles = readdirSync(chainsDirPath);
        const userChains = chainFiles.filter(value => {
            return value !== 'example.config.json' && value.endsWith('.config.json');
        });
        if (process.env.CONFIG_NAME) {
            confPath = resolve(chainsDirPath, `${process.env.CONFIG_NAME}.config.json`);
        } else {
            if (userChains.length > 1) {
                hLog('More than one chain was configured, please set CONFIG_JSON or CONFIG_NAME to start!');
                hLog(userChains);
                process.exit(1);
            } else if (userChains.length === 1) {
                confPath = resolve(chainsDirPath, userChains[0])
            } else {
                hLog(`No chain config file was found under ${chainsDirPath}!`);
            }
        }
    }

    if (!existsSync(confPath)) {
        confPath = join(resolve(), `${process.env.CONFIG_JSON}`);
    }

    if (existsSync(confPath)) {
        try {
            config = JSON.parse(readFileSync(confPath).toString());
        } catch (e: any) {
            hLog('[FATAL]', e.message);
            process.exit(1);
        }
    }

    if (!config) {
        hLog(`[FATAL] Configuration not found: ${confPath}`);
        process.exit(1);
    } else {
        config.activeConfigPath = confPath;
        return config;
    }
}

export const config = getChainConfig();
