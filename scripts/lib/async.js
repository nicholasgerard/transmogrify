'use strict';

// The one asynchronous sleep every module uses, so a test can observe waits in
// one place and no module carries its own timer wrapper.
function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

module.exports = { sleep };
