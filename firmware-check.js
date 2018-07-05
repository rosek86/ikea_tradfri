// Gateway release notes
// https://ww8.ikea.com/ikeahomesmart/releasenotes/releasenotes.html

const fs = require('fs');
const path = require('path');
const util = require('util');
const { exec } = require('child_process');
const { IncomingWebhook } = require('@slack/client');

const execAsync       = util.promisify(exec);
const readdirAsync    = util.promisify(fs.readdir);
const writeFileAsync  = util.promisify(fs.writeFile);
const readFileAsync   = util.promisify(fs.readFile);
const statAsync       = util.promisify(fs.stat);
const mkdirAsync      = util.promisify(fs.mkdir);

const url = process.env.SLACK_WEBHOOK_URL;
const webhook = new IncomingWebhook(url);

// NOTE: for some reason require('request') gives error, wget works okay though
const requestAsync = async (url) => (await execAsync(`wget -O - ${url}`, {
  maxBuffer: 10 * 1024 * 1024
})).stdout;

const otas = [
  { env: 'prod', url: 'https://fw.ota.homesmart.ikea.net/feed/version_info.json' },
  { env: 'test', url: 'http://fw.test.ota.homesmart.ikea.net/feed/version_info.json' },
];

async function writeFiles(files) {
  const promises = files.map((file) => writeFileAsync(file.filepath, file.content));
  await Promise.all(promises);
}

(async () => {
  try {
    const basepath = path.join(__dirname, 'data');
    const files = await readdirAsync(basepath);
    const stats = await Promise.all(
      files.map((file) =>
        statAsync(path.join(basepath, file))
          .then((stat) => ({ file, stat }))
      )
    );
    const sortedFiles = stats.sort((a, b) =>
      b.stat.mtime.getTime() - a.stat.mtime.getTime()
    ).map((stat) => stat.file);

    const results = await Promise.all(
      otas.map((ota) =>
        requestAsync(ota.url)
          .then((result) => ({
            env: ota.env, data: result
          })
        )
      )
    );

    const isodate = (new Date()).toISOString();
    const prodFile = sortedFiles.find((file) => file.match(/prod.json/) !== null);
    const testFile = sortedFiles.find((file) => file.match(/test.json/) !== null);

    if (prodFile && testFile) {
      const filesContent = await Promise.all([
        readFileAsync(path.join(basepath, prodFile), 'utf-8'),
        readFileAsync(path.join(basepath, testFile), 'utf-8')
      ]);

      if (results[0].data === filesContent[0] && results[1].data === filesContent[1]) {
        console.log('firmwares unchanged.');
        return;
      }
    }

    console.log('new firmwares available');

    const firmwares = results.map((result) =>
      JSON.parse(result.data).map((fw) => {
        return {
          env: result.env,
          filename: fw.fw_binary_url.split('/').pop(),
          imageType: fw.fw_image_type,
          contentPromise: requestAsync(fw.fw_binary_url),
          content: '',
        };
      })
    );

    const allFirmwares = firmwares[0].concat(...firmwares[1]);

    const prodVsTest = allFirmwares.reduce((obj, fw) => {
      const type = fw.imageType || 'gateway';
      obj[type] = obj[type] || {};
      obj[type][fw.env] = fw.filename;
      return obj;
    }, {});

    // Wait for firmwares to be downloaded
    await Promise.all(allFirmwares.map((fw) => {
      return fw.contentPromise.then((content) => {
        fw.content = content;
      });
    }));

    const filesList = [
      { filepath: path.join(basepath, `${isodate}-prod.json`), content: results[0].data },
      { filepath: path.join(basepath, `${isodate}-test.json`), content: results[1].data },
      { filepath: path.join(basepath, isodate, `prodVsTest.json`),
        content: JSON.stringify(prodVsTest, null, 2) },
    ];

    for (const firmware of allFirmwares) {
      filesList.push({
        filepath: path.join(basepath, isodate, firmware.env, firmware.filename),
        content: firmware.content
      });
    }

    await mkdirAsync(path.join(basepath, isodate));
    await mkdirAsync(path.join(basepath, isodate, 'prod'));
    await mkdirAsync(path.join(basepath, isodate, 'test'));

    await writeFiles(filesList);

    // Send simple text to the webhook channel
    webhook.send('Tradfri firmware updated!', (err, res) => {
      if (err) {
        console.log(err);
      }
    });
  } catch (err) {
    console.log(err);
  }
})();
