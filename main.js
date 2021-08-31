const { app, BrowserWindow } = require('electron')

function createWindow() {
  win = new BrowserWindow({ show: false, autoHideMenuBar: true });
  win.maximize();
  win.show();

  win.loadFile('dist/index.html')
  // win.loadFile('index.html')
}

app.whenReady().then(() => { createWindow() })
