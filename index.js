const fs = require('fs');
const os = require('os');
const path = require('path');
const minidump = require('minidump');
const ProgressBar = require('progress');

const SYMBOL_BASE_URLS = [
  'https://symbols.mozilla.org/try',
  'https://symbols.electronjs.org',
];

const MinidumpRoot = path.join(__dirname, 'file');

const fetchSymbol = (directory, baseUrl, pdb, id, symbolFileName) => {
  const url = `${baseUrl}/${encodeURIComponent(pdb)}/${id}/${encodeURIComponent(symbolFileName)}`;
  const symbolPath = path.join(directory, pdb, id, symbolFileName);
  return new Promise((resolve, reject) => {
    const child = require('child_process').spawn('curl', [
      '--silent',
      '--location',
      '--create-dirs',
      '--compressed',
      '--fail',
      '--output',
      symbolPath,
      url,
    ]);
    child.once('close', (code) => {
      if (code === 0) {
        resolve(true);
      } else if (code === 22) {
        resolve(false);
      } else {
        reject(new Error(`failed to download ${url} (code ${code})`));
      }
    });
  });
};

const fetchSymbolInBatches = async (directory, baseUrl, modules) => {
  const promiseList = [];
  for (const [pdb, id] of modules) {
    if (!(/^0+$/.test(id))) {
      const symbolFileName = pdb.replace(/(\.pdb)?$/, '.sym');
      const symbolPath = path.join(directory, pdb, id, symbolFileName);
      if (!fs.existsSync(symbolPath) && !fs.existsSync(path.dirname(symbolPath))) {
        promiseList.push(new Promise(async (resolve, reject) => {
          try {
            const result = await fetchSymbol(directory, baseUrl, pdb, id, symbolFileName);
            resolve(result);
          } catch (error) {
            reject(error);
          }
        }));
      }
    }
  }
  return await Promise.all(promiseList);
};

const getFileName = (file, suffix = '') => {
  const allName = path.basename(file);
  const allNameList = allName.split('.');
  return (allNameList[0] || `${makeUid(5)}${currentTimeString()}`) + suffix;
};

const getRawContent = async (file) => {
  const fileHandler = await fs.promises.open(file);
  const fileBuffer = Buffer.alloc(4);
  try {
    const { bytesRead } = await fileHandler.read(fileBuffer, 0, 4, 0);
    // 非minidump文件
    if (bytesRead !== fileBuffer.length) {
      throw new Error(`Not a minidump file (file too short): ${file}`);
    }
    if (fileBuffer.readUInt32BE(0) !== 0x4D444D50) {
      const { buffer } = await fileHandler.read({ position: 0 });
      for (let offset = 0; offset < buffer.length - 4; offset++) {
        if (buffer.readUInt32BE(offset) === 0x4D444D50) {
          const tempFile = path.join(MinidumpRoot, getFileName(file, '_temp') + '.dmp');
          await new Promise((resolve, reject) => {
            fs.createReadStream(file, { start: offset })
              .on('end', resolve)
              .on('error', reject)
              .pipe(fs.createWriteStream(tempFile));
          });
          const string = await getRawContent(tempFile);
          await fs.promises.unlink(tempFile);
          return string;
        }
      }
      throw new Error(`Not a minidump file (MDMP header not found): ${file}`);
    }
    fileHandler.close();
  } catch (error) {
    fileHandler.close();
    throw error;
  }

  return await new Promise((resolve, reject) => {
    minidump.dump(file, (error, buffer) => {
      const result = buffer && buffer.toString ? buffer.toString('utf8') : '';
      if (!result || !result.length) {
        reject(error);
      } else {
        resolve(result);
      }
    });
  });
};

const getParseModules = (content) => {
  const modules = [];
  const regex = /\(debug_file\)\s+= "(?:.+\/)?([^"]+)"\s+\(debug_identifier\)\s+= "([0-9A-F]+)"/mg;
  let module;
  while (module = regex.exec(content)) {
    modules.push([module[1], module[2]]);
  }
  return modules;
};

const getSymbolFiles = async (file, modules) => {
  const directory = path.join(MinidumpRoot, getFileName(file, '_cache'));
  await fetchSymbolInBatches(directory, SYMBOL_BASE_URLS[0], modules);
  await fetchSymbolInBatches(directory, SYMBOL_BASE_URLS[1], modules);
  return directory;
};

const getParseResult = async (file, directory) => {
  const result = await new Promise((resolve, reject) => {
    minidump.walkStack(file, [directory], (error, buffer) => {
      if (error) {
        reject(error);
      } else {
        resolve(buffer);
      }
    });
  });
  return result.toString('utf8');
};

const electronMinidump = async (options) => {
  const { quiet, force, file } = options;
  if (!fs.existsSync(MinidumpRoot)) {
    fs.mkdirSync(MinidumpRoot);
  }
  const current = Date.now();
  console.log('step 1', file, Date.now(), Date.now() - current);
  const rawContent = await getRawContent(file);
  console.log('step 2', rawContent.length, Date.now(), Date.now() - current);
  const modules = getParseModules(rawContent);
  console.log('step 3', modules.length, Date.now(), Date.now() - current);
  const directory = await getSymbolFiles(file, modules);
  console.log('step 4', directory, Date.now(), Date.now() - current);
  const content = await getParseResult(file, directory);
  console.log('step 5', content.length, Date.now(), Date.now() - current);
};

module.exports = { minidump: electronMinidump }
