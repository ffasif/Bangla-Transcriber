const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openFileDialog: () => ipcRenderer.invoke('dialog:open-file'),
  getFileInfo: (filePath) => ipcRenderer.invoke('file:get-info', filePath),
  checkApiKeyStatus: () => ipcRenderer.invoke('env:check-api-key'),
  transcribeMedia: (filePath) => ipcRenderer.invoke('media:transcribe', filePath),
  transcribeYoutube: (url) => ipcRenderer.invoke('video:transcribe', url),
  transcribeVideoUrl: (url) => ipcRenderer.invoke('video:transcribe', url),
  translateToBangla: (text) => ipcRenderer.invoke('media:translate-to-bangla', text),
  onTranslationProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('translation:progress', handler);
    return () => ipcRenderer.removeListener('translation:progress', handler);
  },
  onTranscriptionProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('transcription:progress', handler);
    return () => ipcRenderer.removeListener('transcription:progress', handler);
  },
  getPathForFile: (file) => {
    try {
      if (webUtils && typeof webUtils.getPathForFile === 'function') {
        return webUtils.getPathForFile(file);
      }
      return file.path || '';
    } catch {
      return file.path || '';
    }
  }
});
