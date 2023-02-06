const core = require('../index')({logger:{level:'debug'}});


core.on('usbConnected', device=> {
  console.log('USB Device connected', device);
})

