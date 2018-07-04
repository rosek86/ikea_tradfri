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

const url = process.env.SLACK_WEBHOOK_URL;
const webhook = new IncomingWebhook(url);

// NOTE: for some reason require('request') gives error, wget works okay though
const requestAsync = async (url) => (await execAsync(`wget -O - ${url}`)).stdout;

const otas = [
  { env: 'prod', url: 'https://fw.ota.homesmart.ikea.net/feed/version_info.json' },
  { env: 'test', url: 'http://fw.test.ota.homesmart.ikea.net/feed/version_info.json' },
];

async function writeNewFiles(basepath, isodate, results, prodVsTest) {
  console.log('new firmware info available');
  await writeFileAsync(path.join(basepath, `${isodate}-prod.json`), results[0].data);
  await writeFileAsync(path.join(basepath, `${isodate}-test.json`), results[1].data);
  await writeFileAsync(path.join(basepath, `${isodate}-pvst.json`), prodVsTest);
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
        return;
      }
    }

    const firmwares = results.map((result) =>
      JSON.parse(result.data).map((fw) => {
        return {
          filename: fw.fw_binary_url.split('/').pop(),
          fw_image_type: fw.fw_image_type,
          env: result.env,
        };
      })
    );

    const all = firmwares[0].concat(...firmwares[1]);

    const prodVsTest = all.reduce((obj, fw) => {
      const type = fw.fw_image_type || 'gateway';
      obj[type] = obj[type] || [];
      obj[type].push({ env: fw.env, file: fw.filename });
      return obj;
    }, {});

    await writeNewFiles(basepath, isodate, results, JSON.stringify(prodVsTest, null, 2));

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
