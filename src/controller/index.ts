import {resolve} from "path";
import {HyperionController} from "./hyperion-controller.js";

const controller = new HyperionController();
controller.importConfig(resolve('config', 'controller.json'));
await controller.start();
