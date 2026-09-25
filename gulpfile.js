'use strict'

const connect = require('gulp-connect')
const { execSync } = require('child_process')
const fs = require('fs')
const generator = require('@antora/site-generator-default')
const { reload: livereload } = process.env.LIVERELOAD === 'true' ? require('gulp-connect') : {}
const log = require('fancy-log')
const { series, src, watch } = require('gulp')
const path = require('path')
const yaml = require('js-yaml')

const playbookFilename = process.env.PLAYBOOK || 'antora-playbook.yml'
const playbook = yaml.load(fs.readFileSync(playbookFilename, 'utf8'))
const outputDir = (playbook.output || {}).dir || './build/site'
const serverConfig = {
  name: 'Preview Site',
  livereload,
  port: Number(process.env.PORT) || 5000,
  root: outputDir,
}
const antoraArgs = ['--playbook', playbookFilename]
const watchPatterns = playbook.content.sources.filter((source) => !source.url.includes(':')).reduce((accum, source) => {
  accum.push(`${source.url}/${source.start_path ? source.start_path + '/' : ''}antora.yml`)
  accum.push(`${source.url}/${source.start_path ? source.start_path + '/' : ''}**/*.adoc`)
  return accum
}, [])

const savannaSrc = 'modules/savanna'
const previewSrc = 'build/preview-src'
const antoraUiRoot = path.resolve(__dirname, process.env.ANTORA_UI || '../antora-ui')
const uiBundleZip = path.join(antoraUiRoot, 'build/ui-bundle.zip')

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Preview',
  GIT_AUTHOR_EMAIL: 'preview@local',
  GIT_COMMITTER_NAME: 'Preview',
  GIT_COMMITTER_EMAIL: 'preview@local',
}

function generate (done) {
  generator(antoraArgs, process.env)
    .then(() => done())
    .catch((err) => {
      console.log(err)
      done()
    })
}

function ensurePreviewSrcRepo () {
  if (!fs.existsSync(previewSrc)) {
    fs.mkdirSync(previewSrc, { recursive: true })
  }
  if (!fs.existsSync(path.join(previewSrc, '.git'))) {
    execSync('git init -q', { cwd: previewSrc })
  }
}

function syncPreviewSrc (done) {
  ensurePreviewSrcRepo()
  execSync(`rsync -a --delete --exclude '.git' ${savannaSrc}/ ${previewSrc}/`, { stdio: 'inherit' })
  execSync('git add -A', { cwd: previewSrc, env: gitEnv })
  try {
    execSync('git diff --cached --quiet', { cwd: previewSrc, stdio: 'ignore' })
  } catch (_) {
    execSync('git commit -q -m "local preview snapshot"', { cwd: previewSrc, env: gitEnv })
  }
  done()
}

function rebuildUiBundle (done) {
  if (!fs.existsSync(antoraUiRoot)) {
    done(new Error(`antora-ui not found at ${antoraUiRoot} (set ANTORA_UI)`))
    return
  }
  log(`Building UI bundle in ${antoraUiRoot}`)
  execSync('npx gulp bundle', { cwd: antoraUiRoot, stdio: 'inherit' })
  execSync('rm -rf build/ui-bundle && mkdir -p build/ui-bundle', { stdio: 'inherit' })
  execSync(`unzip -oq ${JSON.stringify(uiBundleZip)} -d build/ui-bundle`, { stdio: 'inherit' })
  // An empty site.js extracts without error and the preview still renders, so the
  // only symptom is that nothing scripted works — collapsible nav groups, the
  // language picker, search. Fail here instead of serving a mute site.
  const siteJs = 'build/ui-bundle/js/site.js'
  if (!fs.existsSync(siteJs) || !fs.statSync(siteJs).size) {
    done(new Error(`${siteJs} is missing or empty; rerun after ${uiBundleZip} finishes writing`))
    return
  }
  done()
}

function serve (done) {
  connect.server(serverConfig, function () {
    this.server.on('close', done)
    watch(watchPatterns, generate)
    if (livereload) watch(this.root).on('change', (filepath) => src(filepath, { read: false }).pipe(livereload()))
  })
}

function debounce (fn, waitMs) {
  let timer
  return (done) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(done), waitMs)
  }
}

function devHot (done) {
  const contentRebuild = series(syncPreviewSrc, generate)
  const uiRebuild = series(rebuildUiBundle, generate)

  series(syncPreviewSrc, rebuildUiBundle, generate)((err) => {
    if (err) {
      done(err)
      return
    }

    connect.server(serverConfig, function () {
      this.server.on('close', done)

      const contentPatterns = [
        `${savannaSrc}/**/*`,
        'lib/**/*.js',
      ]
      const uiPatterns = [
        path.join(antoraUiRoot, 'src/**/*'),
        path.join(antoraUiRoot, 'gulp.d/**/*'),
      ]

      watch(contentPatterns, debounce((cb) => {
        log('cloud-docs change detected — syncing content')
        contentRebuild(cb)
      }, 400))

      watch(uiPatterns, debounce((cb) => {
        log('antora-ui change detected — rebuilding bundle')
        uiRebuild(cb)
      }, 800))

      log(`Hot preview: http://localhost:${serverConfig.port}`)
      log(`Watching ${savannaSrc} and ${path.join(antoraUiRoot, 'src')}`)
    })
  })
}

module.exports = { serve, generate, devHot, default: series(generate, serve) }
