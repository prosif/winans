// renderer.js
// Ported from app.js for Electron
const fs = require('fs');
const os = require('os');
const path = require('path');
const tf = require('@tensorflow/tfjs-node');
const nsfw = require('nsfwjs');
const { extractThumbnails } = require('./video_utils');
const pLimit = require('p-limit');

const AUDIO_EXT = ['.mp3', '.wav', '.aac', '.flac', '.ogg', '.m4a'];
const VIDEO_EXT = ['.mp4', '.avi', '.mov', '.mkv', '.wmv', '.flv', '.webm'];
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.webp'];
const DOC_EXT = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.md', '.rtf', '.odt'];

const NSFW_CONCURRENCY = 2;
const nsfwLimit = pLimit(NSFW_CONCURRENCY);

// Store scroll positions for each list
let listScrollTops = {};

function saveListScrollTops() {
  Object.keys(expandedTypes).forEach(type => {
    if (expandedTypes[type]) {
      const ul = document.getElementById('filelist-' + type);
      if (ul) listScrollTops[type] = ul.scrollTop;
    }
  });
}

function restoreListScrollTops() {
  Object.keys(expandedTypes).forEach(type => {
    if (expandedTypes[type]) {
      const ul = document.getElementById('filelist-' + type);
      if (ul && listScrollTops[type] !== undefined) ul.scrollTop = listScrollTops[type];
    }
  });
}

function logToScreen(msg) {
  const logDiv = document.getElementById('log');
  if (logDiv) {
    logDiv.textContent += msg + '\n';
    logDiv.scrollTop = logDiv.scrollHeight;
  }
}
console.log = (...args) => { logToScreen(args.join(' ')); };
console.error = (...args) => { logToScreen('ERROR: ' + args.join(' ')); };

function getVolumes() {
  const platform = os.platform();
  if (platform === 'darwin') {
    return fs.readdirSync('/Volumes').map(name => path.join('/Volumes', name));
  } else if (platform === 'linux') {
    const media = '/media/' + os.userInfo().username;
    if (fs.existsSync(media)) {
      return fs.readdirSync(media).map(name => path.join(media, name));
    }
    return ['/'];
  } else if (platform === 'win32') {
    const drives = [];
    for (let i = 67; i <= 90; i++) {
      const drive = String.fromCharCode(i) + ':\\';
      if (fs.existsSync(drive)) drives.push(drive);
    }
    return drives;
  }
  return ['/'];
}

function getFreeSpace(volume) {
  try {
    if (os.platform() === 'win32') {
      return 1 * 1024 * 1024 * 1024 * 1024;
    } else {
      const stat = fs.statSync(volume);
      if (stat && stat.dev) {
        const df = require('child_process').execSync(`df -k '${volume.replace(/'/g, "'\\''")}'`).toString();
        const lines = df.split('\n');
        if (lines.length > 1) {
          const parts = lines[1].split(/\s+/);
          if (parts.length > 3) {
            return parseInt(parts[3], 10) * 1024;
          }
        }
      }
    }
  } catch (e) { console.error('getFreeSpace error:', e); }
  return 0;
}

let state = {
  screen: 'main',
  source: null,
  destination: null,
  destFolder: null,
  filesToCopy: [],
  copyProgress: 0,
  debug: false,
  filterMode: 'explicit', // 'explicit', 'non-explicit', 'none'
  analyze: {
    running: false,
    done: false,
    audio: 0,
    video: 0,
    image: 0,
    doc: 0,
    other: 0,
    total: 0,
    size: 0,
    files: [],
    nsfwImages: 0,
    nsfwVideos: 0,
    nsfwImageFiles: [],
    nsfwVideoFiles: []
  }
};

// Konami code sequence
const KONAMI_CODE = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
let konamiIndex = 0;

// Add Konami code listener
document.addEventListener('keydown', (e) => {
  if (e.key === KONAMI_CODE[konamiIndex]) {
    konamiIndex++;
    if (konamiIndex === KONAMI_CODE.length) {
      state.debug = !state.debug;
      konamiIndex = 0;
      render();
    }
  } else {
    konamiIndex = 0;
  }
});

// Add debug menu
function createDebugMenu() {
  const menu = document.createElement('div');
  menu.style.position = 'fixed';
  menu.style.top = '10px';
  menu.style.right = '10px';
  menu.style.background = '#f0f0f0';
  menu.style.padding = '10px';
  menu.style.borderRadius = '5px';
  menu.style.boxShadow = '0 2px 5px rgba(0,0,0,0.2)';
  menu.style.zIndex = '1000';

  const title = document.createElement('div');
  title.textContent = 'Debug Menu';
  title.style.fontWeight = 'bold';
  title.style.marginBottom = '10px';
  menu.appendChild(title);

  const filterLabel = document.createElement('div');
  filterLabel.textContent = 'Filter:';
  filterLabel.style.marginBottom = '5px';
  menu.appendChild(filterLabel);

  const filterOptions = ['explicit', 'non-explicit', 'none'];
  filterOptions.forEach(option => {
    const label = document.createElement('label');
    label.style.display = 'block';
    label.style.marginBottom = '5px';
    label.style.cursor = 'pointer';

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'filter';
    radio.value = option;
    radio.checked = state.filterMode === option;
    radio.onchange = () => {
      state.filterMode = option;
      if (state.analyze.done) {
        // Re-filter files if analysis is complete
        state.filesToCopy = filterFiles(state.analyze.files);
        render();
      }
    };

    const text = document.createElement('span');
    text.textContent = option === 'explicit' ? 'Filter explicit (default)' :
                      option === 'non-explicit' ? 'Filter non-explicit' :
                      'No filter';

    label.appendChild(radio);
    label.appendChild(text);
    menu.appendChild(label);
  });

  return menu;
}

// Filter files based on current filter mode
function filterFiles(files) {
  if (state.filterMode === 'none') return files;
  
  return files.filter(file => {
    const isNSFW = state.analyze.nsfwImageFiles.includes(file) || 
                   state.analyze.nsfwVideoFiles.includes(file);
    return state.filterMode === 'explicit' ? !isNSFW : isNSFW;
  });
}

let nsfwModel = null;
async function loadNSFWModel() {
  if (!nsfwModel) {
    nsfwModel = await nsfw.load('file://./models/mobilenet_v2/model.json');
  }
  return nsfwModel;
}

// Add expanded state for collapsible lists
let expandedTypes = {
  audio: false,
  video: false,
  image: false,
  doc: false,
  other: false,
  nsfwImages: false,
  nsfwVideos: false
};

function toggleType(type) {
  expandedTypes[type] = !expandedTypes[type];
  render();
}

function getFilesByType(type) {
  return state.analyze.files.filter(file => {
    const ext = path.extname(file).toLowerCase();
    if (type === 'audio') return AUDIO_EXT.includes(ext);
    if (type === 'video') return VIDEO_EXT.includes(ext);
    if (type === 'image') return IMAGE_EXT.includes(ext);
    if (type === 'doc') return DOC_EXT.includes(ext);
    if (type === 'other') return (
      !AUDIO_EXT.includes(ext) &&
      !VIDEO_EXT.includes(ext) &&
      !IMAGE_EXT.includes(ext) &&
      !DOC_EXT.includes(ext)
    );
    return false;
  });
}

// Add close button function
function createCloseButton() {
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕ Close App';
  closeBtn.style.position = 'fixed';
  closeBtn.style.top = '20px';
  closeBtn.style.right = '20px';
  closeBtn.style.padding = '10px 20px';
  closeBtn.style.backgroundColor = '#ff4444';
  closeBtn.style.color = 'white';
  closeBtn.style.border = 'none';
  closeBtn.style.borderRadius = '5px';
  closeBtn.style.cursor = 'pointer';
  closeBtn.style.fontWeight = 'bold';
  closeBtn.style.boxShadow = '0 2px 5px rgba(0,0,0,0.2)';
  closeBtn.style.zIndex = '1000';
  closeBtn.style.transition = 'background-color 0.2s';
  
  // Add hover effect
  closeBtn.onmouseover = () => {
    closeBtn.style.backgroundColor = '#ff0000';
  };
  closeBtn.onmouseout = () => {
    closeBtn.style.backgroundColor = '#ff4444';
  };
  
  // Add click handler
  closeBtn.onclick = () => {
    if (confirm('Are you sure you want to close the application? Any unsaved progress will be lost.')) {
      const { ipcRenderer } = require('electron');
      ipcRenderer.send('quit-app');
    }
  };
  
  return closeBtn;
}

function render() {
  saveListScrollTops();
  const app = document.getElementById('app');
  app.innerHTML = '';

  // Remove existing debug menu if it exists
  const existingDebugMenu = document.querySelector('.debug-menu');
  if (existingDebugMenu) {
    existingDebugMenu.remove();
  }

  // Remove existing close button if it exists
  const existingCloseBtn = document.querySelector('.close-button');
  if (existingCloseBtn) {
    existingCloseBtn.remove();
  }

  // Add close button
  const closeBtn = createCloseButton();
  closeBtn.className = 'close-button';
  document.body.appendChild(closeBtn);

  // Add debug menu if debug mode is active
  if (state.debug) {
    const debugMenu = createDebugMenu();
    debugMenu.className = 'debug-menu';
    document.body.appendChild(debugMenu);
  }

  if (state.screen === 'main') {
    renderMainScreen(app);
  } else if (state.screen === 'analyzing') {
    renderAnalyzingScreen(app);
  } else if (state.screen === 'copy') {
    renderCopyScreen(app);
  } else if (state.screen === 'confirm') {
    renderConfirmScreen(app);
  } else if (state.screen === 'progress') {
    renderProgressScreen(app);
  }
  restoreListScrollTops();
}

function renderMainScreen(app) {
  const title = document.createElement('h2');
  title.textContent = 'Select Source Volume';
  app.appendChild(title);

  const list = document.createElement('div');
  list.className = 'list';
  getVolumes().forEach(volume => {
    const item = document.createElement('div');
    item.className = 'list-item';
    item.textContent = volume;
    item.onclick = () => {
      state.source = volume;
      state.screen = 'analyzing';
      state.analyze = {
        running: true,
        done: false,
        audio: 0,
        video: 0,
        image: 0,
        doc: 0,
        other: 0,
        total: 0,
        size: 0,
        files: [],
        nsfwImages: 0,
        nsfwVideos: 0,
        nsfwImageFiles: [],
        nsfwVideoFiles: []
      };
      render();
      startAnalyzing(volume);
    };
    list.appendChild(item);
  });
  app.appendChild(list);
}

function renderAnalyzingScreen(app) {
  const title = document.createElement('h2');
  title.textContent = state.analyze.done ? 'Files to copy' : 'Analyzing Volume...';
  app.appendChild(title);

  if (!state.debug) {
    // Simple progress view for non-debug mode
    const progressContainer = document.createElement('div');
    progressContainer.style.width = '100%';
    progressContainer.style.maxWidth = '400px';
    progressContainer.style.margin = '20px auto';
    
    const progressBar = document.createElement('div');
    progressBar.style.width = '100%';
    progressBar.style.height = '20px';
    progressBar.style.background = '#f0f0f0';
    progressBar.style.borderRadius = '10px';
    progressBar.style.overflow = 'hidden';
    
    const progressInner = document.createElement('div');
    const progress = state.analyze.total > 0 ? (state.analyze.files.length / state.analyze.total) : 0;
    progressInner.style.width = `${progress * 100}%`;
    progressInner.style.height = '100%';
    progressInner.style.background = '#4CAF50';
    progressInner.style.transition = 'width 0.3s ease';
    
    progressBar.appendChild(progressInner);
    progressContainer.appendChild(progressBar);
    
    const statusText = document.createElement('div');
    statusText.style.textAlign = 'center';
    statusText.style.marginTop = '10px';
    statusText.style.color = '#666';
    statusText.textContent = state.analyze.done ? 'Analysis complete' : `Finding files... (${state.analyze.files.length}/${state.analyze.total})`;
    
    progressContainer.appendChild(statusText);
    app.appendChild(progressContainer);
  } else {
    // Detailed debug view
    function makeSection(label, type, count, files) {
      const section = document.createElement('div');
      section.style.marginBottom = '8px';
      const header = document.createElement('div');
      header.style.cursor = 'pointer';
      header.style.fontWeight = 'bold';
      header.onclick = () => toggleType(type);
      header.textContent = `${label}: ${count} ${expandedTypes[type] ? '▼' : '▶'}`;
      section.appendChild(header);
      if (expandedTypes[type]) {
        const list = document.createElement('ul');
        list.id = 'filelist-' + type;
        list.style.margin = '4px 0 4px 20px';
        list.style.maxHeight = '200px';
        list.style.overflowY = 'auto';
        files.forEach(f => {
          const li = document.createElement('li');
          li.style.cursor = 'pointer';
          li.style.color = '#0066cc';
          li.textContent = f;
          li.onclick = () => {
            // Use Electron to open the file
            require('electron').shell.openPath(f);
          };
          li.onmouseover = () => {
            li.style.textDecoration = 'underline';
          };
          li.onmouseout = () => {
            li.style.textDecoration = 'none';
          };
          list.appendChild(li);
        });
        section.appendChild(list);
      }
      return section;
    }

    app.appendChild(makeSection('Audio', 'audio', state.analyze.audio, getFilesByType('audio')));
    app.appendChild(makeSection('Video', 'video', state.analyze.video, getFilesByType('video')));
    app.appendChild(makeSection('Images', 'image', state.analyze.image, getFilesByType('image')));
    app.appendChild(makeSection('Documents', 'doc', state.analyze.doc, getFilesByType('doc')));
    app.appendChild(makeSection('Other', 'other', state.analyze.other, getFilesByType('other')));
    app.appendChild(makeSection('NSFW Images', 'nsfwImages', state.analyze.nsfwImages, state.analyze.nsfwImageFiles));
    app.appendChild(makeSection('NSFW Videos', 'nsfwVideos', state.analyze.nsfwVideos, state.analyze.nsfwVideoFiles));

    const nsfwDiv = document.createElement('div');
    nsfwDiv.innerHTML = `
      <p>Total files: <b>${state.analyze.total}</b></p>
      <p>Total size: <b>${formatBytes(state.analyze.size)}</b></p>
    `;
    app.appendChild(nsfwDiv);
  }

  if (!state.analyze.done) {
    const spinner = document.createElement('div');
    spinner.textContent = 'Analyzing...';
    spinner.style.fontWeight = 'bold';
    spinner.style.color = '#888';
    spinner.style.margin = '20px 0';
    app.appendChild(spinner);
  } else {
    const continueBtn = document.createElement('button');
    continueBtn.className = 'button';
    continueBtn.textContent = 'Continue';
    continueBtn.onclick = () => {
      state.screen = 'copy';
      render();
    };
    app.appendChild(continueBtn);
  }
}

function startAnalyzing(volume) {
  (async () => {
    const model = await loadNSFWModel();
    let nsfwPromises = [];
    state.analyze.nsfwImages = 0;
    state.analyze.nsfwVideos = 0;
    state.analyze.nsfwImageFiles = [];
    state.analyze.nsfwVideoFiles = [];

    // First pass: count total files
    let totalFiles = 0;
    function countFiles(dir) {
      try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (file.startsWith('.')) continue; // Ignore hidden files and directories
          const fullPath = path.join(dir, file);
          try {
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
              countFiles(fullPath);
            } else if (stat.isFile()) {
              const ext = path.extname(file).toLowerCase();
              if (AUDIO_EXT.includes(ext) || VIDEO_EXT.includes(ext) || 
                  IMAGE_EXT.includes(ext) || DOC_EXT.includes(ext)) {
                totalFiles++;
              }
            }
          } catch (e) { console.error('Stat error:', e); }
        }
      } catch (e) { console.error('Read dir error:', e); }
    }
    countFiles(volume);
    state.analyze.total = totalFiles;

    let processedFiles = 0;
    async function scanDir(dir) {
      try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (file.startsWith('.')) continue; // Ignore hidden files and directories
          const fullPath = path.join(dir, file);
          try {
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
              await scanDir(fullPath);
            } else if (stat.isFile()) {
              const ext = path.extname(file).toLowerCase();
              if (AUDIO_EXT.includes(ext) || VIDEO_EXT.includes(ext) || 
                  IMAGE_EXT.includes(ext) || DOC_EXT.includes(ext)) {
                processedFiles++;
                state.analyze.size += stat.size;
                state.analyze.files.push(fullPath);
                if (AUDIO_EXT.includes(ext)) state.analyze.audio++;
                else if (VIDEO_EXT.includes(ext)) {
                  state.analyze.video++;
                  nsfwPromises.push(nsfwLimit(async () => {
                    try {
                      const thumbs = await extractThumbnails(fullPath, 3, '.electron-thumbs');
                      let nsfwFound = false;
                      for (const thumb of thumbs) {
                        try {
                          if (!fs.existsSync(thumb)) {
                            console.warn('Thumbnail missing, skipping:', thumb);
                            continue;
                          }
                          const image = await tf.node.decodeImage(require('fs').readFileSync(thumb), 3);
                          const predictions = await model.classify(image);
                          image.dispose();
                          if (predictions.some(p => (['Hentai', 'Porn', 'Sexy'].includes(p.className) && p.probability > 0.7))) {
                            nsfwFound = true;
                          }
                        } catch (e) { console.error('NSFW video image error:', e); }
                        try { require('fs').unlinkSync(thumb); } catch (e) {}
                      }
                      if (nsfwFound) {
                        state.analyze.nsfwVideos++;
                        state.analyze.nsfwVideoFiles.push(fullPath);
                      }
                    } catch (e) { console.error('NSFW video error:', e); }
                    render();
                  }));
                }
                else if (IMAGE_EXT.includes(ext)) {
                  state.analyze.image++;
                  nsfwPromises.push(nsfwLimit(async () => {
                    try {
                      const image = await tf.node.decodeImage(require('fs').readFileSync(fullPath), 3);
                      const predictions = await model.classify(image);
                      image.dispose();
                      if (predictions.some(p => (['Hentai', 'Porn', 'Sexy'].includes(p.className) && p.probability > 0.7))) {
                        state.analyze.nsfwImages++;
                        state.analyze.nsfwImageFiles.push(fullPath);
                      }
                    } catch (e) { console.error('NSFW image error:', e); }
                    render();
                  }));
                }
                else if (DOC_EXT.includes(ext)) state.analyze.doc++;
                render();
              }
            }
          } catch (e) { console.error('Stat error:', e); }
        }
      } catch (e) { console.error('Read dir error:', e); }
    }
    await scanDir(volume);
    await Promise.all(nsfwPromises);
    state.analyze.done = true;
    state.analyze.running = false;
    // Apply initial filter based on current filter mode
    state.filesToCopy = filterFiles(state.analyze.files);
    render();
  })();
}

function renderCopyScreen(app) {
  const title = document.createElement('h2');
  title.textContent = `Copy FROM: ${state.source}`;
  app.appendChild(title);

  const subtitle = document.createElement('div');
  subtitle.textContent = 'Select Destination Volume:';
  app.appendChild(subtitle);

  const list = document.createElement('div');
  list.className = 'list';
  const neededSpace = state.analyze.size;
  getVolumes().filter(v => v !== state.source).forEach(volume => {
    const free = getFreeSpace(volume);
    const hasSpace = free >= neededSpace;
    const item = document.createElement('div');
    item.className = 'list-item';
    item.textContent = `${volume} (Free: ${formatBytes(free)})`;
    if (!hasSpace) {
      item.style.color = '#aaa';
      item.style.background = '#f8f8f8';
      item.style.cursor = 'not-allowed';
    } else {
      item.onclick = () => {
        state.destination = volume;
        state.destFolder = volume; // Default to root
        renderFolderTree(volume);
      };
    }
    list.appendChild(item);
  });
  app.appendChild(list);

  // Folder tree container
  const folderTree = document.createElement('div');
  folderTree.id = 'folder-tree';
  folderTree.style.marginTop = '20px';
  folderTree.style.display = 'none';
  app.appendChild(folderTree);

  function renderFolderTree(rootPath) {
    folderTree.style.display = 'block';
    folderTree.innerHTML = '';

    const currentPath = document.createElement('div');
    currentPath.style.marginBottom = '10px';
    currentPath.style.fontWeight = 'bold';
    currentPath.textContent = `Current path: ${rootPath}`;
    folderTree.appendChild(currentPath);

    // Create new folder button
    const newFolderBtn = document.createElement('button');
    newFolderBtn.className = 'button';
    newFolderBtn.textContent = 'Create New Folder';
    newFolderBtn.style.marginBottom = '10px';
    newFolderBtn.onclick = () => {
      const folderName = prompt('Enter folder name:');
      if (folderName) {
        const newPath = path.join(rootPath, folderName);
        try {
          fs.mkdirSync(newPath);
          renderFolderTree(rootPath); // Refresh the view
        } catch (e) {
          alert('Error creating folder: ' + e.message);
        }
      }
    };
    folderTree.appendChild(newFolderBtn);

    // List folders
    const folders = document.createElement('div');
    folders.className = 'folder-list';
    folders.style.marginTop = '10px';

    try {
      const items = fs.readdirSync(rootPath);
      items.forEach(item => {
        const fullPath = path.join(rootPath, item);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            const folderItem = document.createElement('div');
            folderItem.className = 'folder-item';
            folderItem.style.padding = '5px';
            folderItem.style.cursor = 'pointer';
            folderItem.style.display = 'flex';
            folderItem.style.alignItems = 'center';
            folderItem.style.gap = '10px';

            const folderIcon = document.createElement('span');
            folderIcon.textContent = '📁';
            folderItem.appendChild(folderIcon);

            const folderName = document.createElement('span');
            folderName.textContent = item;
            folderItem.appendChild(folderName);

            folderItem.onclick = () => {
              renderFolderTree(fullPath);
            };

            folders.appendChild(folderItem);
          }
        } catch (e) {
          console.error('Error reading item:', e);
        }
      });
    } catch (e) {
      console.error('Error reading directory:', e);
    }

    folderTree.appendChild(folders);

    // Select current folder button
    const selectBtn = document.createElement('button');
    selectBtn.className = 'button';
    selectBtn.textContent = 'Select This Folder';
    selectBtn.style.marginTop = '20px';
    selectBtn.onclick = () => {
      state.destFolder = rootPath;
      // Ensure filesToCopy is set before moving to confirm screen
      if (!state.filesToCopy || state.filesToCopy.length === 0) {
        state.filesToCopy = filterFiles(state.analyze.files);
      }
      state.screen = 'confirm';
      render();
    };
    folderTree.appendChild(selectBtn);

    // Back button (if not at root)
    if (rootPath !== state.destination) {
      const backBtn = document.createElement('button');
      backBtn.className = 'button';
      backBtn.textContent = 'Back';
      backBtn.style.marginTop = '10px';
      backBtn.style.marginLeft = '10px';
      backBtn.onclick = () => {
        renderFolderTree(path.dirname(rootPath));
      };
      folderTree.appendChild(backBtn);
    }
  }
}

function renderConfirmScreen(app) {
  const title = document.createElement('h2');
  title.textContent = 'Confirm Copy';
  app.appendChild(title);

  // Ensure filesToCopy is set
  if (!state.filesToCopy || state.filesToCopy.length === 0) {
    state.filesToCopy = filterFiles(state.analyze.files);
  }

  // Calculate filtered counts and size
  const filteredCounts = {
    audio: 0,
    video: 0,
    image: 0,
    doc: 0
  };
  let filteredSize = 0;

  state.filesToCopy.forEach(file => {
    const ext = path.extname(file).toLowerCase();
    if (AUDIO_EXT.includes(ext)) filteredCounts.audio++;
    else if (VIDEO_EXT.includes(ext)) filteredCounts.video++;
    else if (IMAGE_EXT.includes(ext)) filteredCounts.image++;
    else if (DOC_EXT.includes(ext)) filteredCounts.doc++;

    try {
      const stat = fs.statSync(file);
      filteredSize += stat.size;
    } catch (e) {
      console.error('Error getting file size:', e);
    }
  });

  if (!state.debug) {
    // Simple confirmation view for non-debug mode
    const summary = document.createElement('div');
    const fileTypes = [];
    if (filteredCounts.audio > 0) fileTypes.push(`${filteredCounts.audio} audio file${filteredCounts.audio === 1 ? '' : 's'}`);
    if (filteredCounts.image > 0) fileTypes.push(`${filteredCounts.image} image${filteredCounts.image === 1 ? '' : 's'}`);
    if (filteredCounts.video > 0) fileTypes.push(`${filteredCounts.video} video${filteredCounts.video === 1 ? '' : 's'}`);
    if (filteredCounts.doc > 0) fileTypes.push(`${filteredCounts.doc} document${filteredCounts.doc === 1 ? '' : 's'}`);
    
    const fileTypeText = fileTypes.join(', ');
    summary.innerHTML = `
      <p>You want to copy ${fileTypeText} from <b>${state.source}</b> to <b>${state.destFolder}</b>.</p>
      <p>Total size: <b>${formatBytes(filteredSize)}</b></p>
      <p>Files to copy: <b>${state.filesToCopy.length}</b></p>
    `;
    app.appendChild(summary);
  } else {
    // Detailed debug view
    function makeSection(label, type, count, files) {
      const section = document.createElement('div');
      section.style.marginBottom = '8px';
      const header = document.createElement('div');
      header.style.cursor = 'pointer';
      header.style.fontWeight = 'bold';
      header.onclick = () => toggleType(type);
      header.textContent = `${label}: ${count} ${expandedTypes[type] ? '▼' : '▶'}`;
      section.appendChild(header);
      if (expandedTypes[type]) {
        const list = document.createElement('ul');
        list.id = 'filelist-' + type;
        list.style.margin = '4px 0 4px 20px';
        list.style.maxHeight = '200px';
        list.style.overflowY = 'auto';
        files.forEach(f => {
          const li = document.createElement('li');
          li.style.cursor = 'pointer';
          li.style.color = '#0066cc';
          li.textContent = f;
          li.onclick = () => {
            require('electron').shell.openPath(f);
          };
          li.onmouseover = () => {
            li.style.textDecoration = 'underline';
          };
          li.onmouseout = () => {
            li.style.textDecoration = 'none';
          };
          list.appendChild(li);
        });
        section.appendChild(list);
      }
      return section;
    }

    const summary = document.createElement('div');
    summary.innerHTML = `
      <p>You want to copy <b>${state.filesToCopy.length}</b> items from <b>${state.source}</b> to <b>${state.destFolder}</b>.</p>
      <p>Total size: <b>${formatBytes(filteredSize)}</b></p>
      <p>Current filter mode: <b>${state.filterMode}</b></p>
      <p>Filtered counts:</p>
      <ul>
        <li>Audio: <b>${filteredCounts.audio}</b></li>
        <li>Video: <b>${filteredCounts.video}</b></li>
        <li>Images: <b>${filteredCounts.image}</b></li>
        <li>Documents: <b>${filteredCounts.doc}</b></li>
      </ul>
    `;
    app.appendChild(summary);

    // Show filtered files in debug mode
    const filteredFiles = state.filesToCopy;
    app.appendChild(makeSection('Audio', 'audio', filteredCounts.audio, filteredFiles.filter(f => AUDIO_EXT.includes(path.extname(f).toLowerCase()))));
    app.appendChild(makeSection('Video', 'video', filteredCounts.video, filteredFiles.filter(f => VIDEO_EXT.includes(path.extname(f).toLowerCase()))));
    app.appendChild(makeSection('Images', 'image', filteredCounts.image, filteredFiles.filter(f => IMAGE_EXT.includes(path.extname(f).toLowerCase()))));
    app.appendChild(makeSection('Documents', 'doc', filteredCounts.doc, filteredFiles.filter(f => DOC_EXT.includes(path.extname(f).toLowerCase()))));
  }

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'button';
  confirmBtn.textContent = 'Confirm';
  confirmBtn.onclick = () => {
    state.screen = 'progress';
    render();
    startCopy();
  };
  app.appendChild(confirmBtn);
}

function renderProgressScreen(app) {
  const title = document.createElement('h2');
  title.textContent = 'Copy Progress';
  app.appendChild(title);

  const progressBar = document.createElement('div');
  progressBar.className = 'progress-bar';
  const progressInner = document.createElement('div');
  progressInner.className = 'progress-bar-inner';
  progressInner.style.width = `${state.copyProgress * 100}%`;
  progressBar.appendChild(progressInner);
  app.appendChild(progressBar);

  // Add status text
  const statusText = document.createElement('div');
  statusText.style.textAlign = 'center';
  statusText.style.marginTop = '10px';
  statusText.style.color = '#666';
  statusText.textContent = state.copyProgress >= 1 ? 'Copy complete!' : 'Copying files...';
  app.appendChild(statusText);

  if (state.copyProgress >= 1) {
    const completeBtn = document.createElement('button');
    completeBtn.className = 'button';
    completeBtn.textContent = 'Complete';
    completeBtn.onclick = () => {
      const { ipcRenderer } = require('electron');
      ipcRenderer.send('quit-app');
    };
    app.appendChild(completeBtn);
  }
}

function startCopy() {
  let copied = 0;
  const total = state.filesToCopy.length;

  // Create backup folder name with date and time
  const date = new Date();
  const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
  const timeStr = date.toTimeString().split(' ')[0].substring(0, 5); // HH:mm
  const volumeName = path.basename(state.source);
  const backupFolderName = `${volumeName}_backup_${dateStr}_${timeStr}`;
  const backupFolderPath = path.join(state.destFolder, backupFolderName);

  // Calculate which category folders we need
  const neededCategories = new Set();
  state.filesToCopy.forEach(file => {
    const ext = path.extname(file).toLowerCase();
    if (AUDIO_EXT.includes(ext)) neededCategories.add('audio');
    else if (VIDEO_EXT.includes(ext)) neededCategories.add('video');
    else if (IMAGE_EXT.includes(ext)) neededCategories.add('image');
    else if (DOC_EXT.includes(ext)) neededCategories.add('doc');
  });

  // Create category folders only for needed categories
  const categoryFolders = {};
  if (neededCategories.has('audio')) categoryFolders.audio = path.join(backupFolderPath, 'Audio');
  if (neededCategories.has('video')) categoryFolders.video = path.join(backupFolderPath, 'Video');
  if (neededCategories.has('image')) categoryFolders.image = path.join(backupFolderPath, 'Images');
  if (neededCategories.has('doc')) categoryFolders.doc = path.join(backupFolderPath, 'Documents');

  // Create all needed folders
  try {
    fs.mkdirSync(backupFolderPath);
    Object.values(categoryFolders).forEach(folder => {
      fs.mkdirSync(folder);
    });
  } catch (e) {
    console.error('Error creating folders:', e);
    alert('Error creating backup folders. Please try again.');
    return;
  }

  function getCategoryFolder(file) {
    const ext = path.extname(file).toLowerCase();
    if (AUDIO_EXT.includes(ext)) return categoryFolders.audio;
    if (VIDEO_EXT.includes(ext)) return categoryFolders.video;
    if (IMAGE_EXT.includes(ext)) return categoryFolders.image;
    if (DOC_EXT.includes(ext)) return categoryFolders.doc;
    return null;
  }

  function copyNext() {
    if (copied >= total) {
      state.copyProgress = 1;
      render();
      return;
    }

    const src = state.filesToCopy[copied];
    const categoryFolder = getCategoryFolder(src);
    if (!categoryFolder) {
      copied++;
      state.copyProgress = copied / total;
      render();
      setTimeout(copyNext, 10);
      return;
    }

    const dest = path.join(categoryFolder, path.basename(src));
    fs.copyFile(src, dest, err => {
      if (err) {
        console.error('Error copying file:', err);
        // Continue with next file even if this one fails
      }
      copied++;
      state.copyProgress = copied / total;
      render();
      setTimeout(copyNext, 10);
    });
  }

  // Update the progress screen to show the backup folder path
  const progressTitle = document.querySelector('h2');
  if (progressTitle) {
    progressTitle.textContent = `Copying to ${backupFolderPath}`;
  }

  copyNext();
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

window.onload = render; 