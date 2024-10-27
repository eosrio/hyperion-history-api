import {Command} from "commander";

const __dirname = new URL('.', import.meta.url).pathname;

const program = new Command();
program.parse(process.argv);
