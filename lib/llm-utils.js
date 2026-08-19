'use strict'

/**
 * Shared helpers for LLM-oriented Antora extensions.
 */

function stripTags (html) {
  return String(html || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function htmlToMdUrl (url) {
  if (typeof url !== 'string') return url
  return url.replace(/\.html(?=[#?]|$)/, '.md')
}

module.exports = { stripTags, htmlToMdUrl }
