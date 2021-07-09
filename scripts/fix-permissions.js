const os = require('os');

if (os.type() === 'Windows_NT') {
  console.log('Skipping permission update on windows');
} else {
  console.log('Updating permissions...');
}
