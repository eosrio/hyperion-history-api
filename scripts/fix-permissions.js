import os from "os";
import {execSync} from "child_process";

if (os.type() === 'Windows_NT') {
  console.log('Skipping permission update on windows');
} else {
  console.log('Updating permissions...');
  execSync('chmod u+x run.sh stop.sh hpm hyp-config');
}
