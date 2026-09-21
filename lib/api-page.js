'use strict'

/**
 * Builds the reference page body for one endpoint from the vendored OpenAPI
 * spec: parameter and response schemas expanded in full, plus request samples
 * in every language the picker offers.
 *
 * Attribute prose comes from the spec where it exists and from
 * lib/api-descriptions.json otherwise; response examples come from
 * lib/api-examples.json where they are curated and are synthesised from the
 * schema where they are not.
 */

const fs = require('fs')
const path = require('path')

const BASE_URL = 'https://api.tgcloud.io'
// Deep enough for every schema in the current spec; only a guard against a
// pathological one. Recursion already stops when a definition repeats.
const MAX_DEPTH = 12
const MAX_EXAMPLE_DEPTH = 4
// Angle brackets mark a string as a slot to fill or read, not a literal value.
const STRING_PLACEHOLDER = '<string>'

const LANGUAGES = [
  ['curl', 'cURL', 'bash'],
  ['python', 'Python', 'python'],
  ['javascript', 'JavaScript', 'javascript'],
  ['php', 'PHP', 'php'],
  ['go', 'Go', 'go'],
  ['java', 'Java', 'java'],
  ['ruby', 'Ruby', 'ruby'],
]

const spec = readJson(path.join(__dirname, '..', 'modules/savanna/modules/rest-api/_catalog/openapi.json'))
const descriptions = readJson(path.join(__dirname, 'api-descriptions.json'))
const examples = readJson(path.join(__dirname, 'api-examples.json'))

function readJson (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function escapeHtml (value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function slugify (value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function refName (schema) {
  const ref = schema && schema.$ref
  return ref ? ref.replace('#/definitions/', '') : null
}

function resolve (schema) {
  const name = refName(schema)
  return name ? spec.definitions[name] || {} : schema || {}
}

/** Flattens allOf so a response reads as one object, and names its owner. */
function flatten (schema) {
  const out = { name: refName(schema), properties: {}, required: [] }
  const resolved = resolve(schema)
  for (const part of resolved.allOf || [resolved]) {
    const inner = resolve(part)
    if (!out.name) out.name = refName(part)
    Object.assign(out.properties, inner.properties || {})
    out.required = out.required.concat(inner.required || [])
  }
  return out
}

function typeLabel (schema) {
  const resolved = resolve(schema)
  if (resolved.allOf) return 'object'
  if (resolved.type === 'array') return typeLabel(resolved.items) + '[]'
  if (resolved.enum) return resolved.type || 'string'
  if (resolved.type && resolved.type !== 'object') return resolved.type
  return 'object'
}

/** The object behind a field, once arrays are unwrapped, or null if it has no attributes. */
function objectBehind (schema) {
  const resolved = resolve(schema)
  if (resolved.type === 'array') return objectBehind(resolved.items)
  const flat = flatten(schema)
  return Object.keys(flat.properties).length ? flat : null
}

/**
 * The line of constraints under a description: the closed set of values a
 * field accepts, and any bound the spec puts on it.
 */
function facets (schema) {
  const resolved = resolve(schema)
  const source = resolved.type === 'array' ? resolve(resolved.items) : resolved
  const parts = []
  if (source.enum) {
    parts.push('Available options: ' + source.enum.map((value) => '<code>' + escapeHtml(value) + '</code>').join(', '))
  }
  if (source.default !== undefined) parts.push('Default: <code>' + escapeHtml(source.default) + '</code>')
  if (source.minimum !== undefined) parts.push('Minimum: <code>' + escapeHtml(source.minimum) + '</code>')
  if (source.maximum !== undefined) parts.push('Maximum: <code>' + escapeHtml(source.maximum) + '</code>')
  return parts.length ? '<p class="api-facets">' + parts.join(' &middot; ') + '</p>' : ''
}

function describe (owner, key, schema) {
  const resolved = resolve(schema)
  const own = (descriptions[owner] || {})[key]
  return schema.description || resolved.description || own || ''
}

/**
 * The spec's operation descriptions restate the summary ("Create a new cloud
 * provider"), which leaves out the context a reader needs to tell whether an
 * endpoint applies to them. An entry under _operations replaces that opening
 * paragraph; the spec's own text is the fallback.
 */
function lead (endpoint, operation) {
  const override = (descriptions._operations || {})[endpoint.method + ' ' + endpoint.path]
  return override || operation.description || operation.summary || ''
}

function indent (level) {
  return ' '.repeat(level)
}

function typeTags (schema, key, required) {
  const tags = ['<span class="api-type">' + typeLabel(schema) + '</span>']
  if (required.includes(key)) tags.push('<span class="api-required">required</span>')
  return tags.join('\n')
}

/**
 * Renders the attributes of an object as nested disclosures. `trail` holds the
 * definitions already open above this point so a self-referencing schema stops
 * instead of recursing forever.
 */
function renderChildren (owner, pad, trail, depth) {
  const out = []
  for (const key of Object.keys(owner.properties).sort()) {
    const schema = owner.properties[key]
    const description = describe(owner.name, key, schema)
    const nested = objectBehind(schema)
    const open = nested && !trail.has(nested.name) && depth < MAX_DEPTH

    out.push(indent(pad) + '<div>')
    out.push(
      indent(pad + 2) +
        '<div class="api-child-field-heading"><code>' +
        escapeHtml(key) +
        '</code>' +
        typeTags(schema, key, owner.required).replace(/\n/g, '') +
        '</div>'
    )
    if (description) out.push(indent(pad + 2) + '<p>' + escapeHtml(description) + '</p>')
    const limits = facets(schema)
    if (limits) out.push(indent(pad + 2) + limits)
    if (open) {
      out.push(indent(pad + 2) + '<details class="api-schema-details">')
      out.push(indent(pad + 4) + '<summary>')
      out.push(indent(pad + 6) + '<span class="api-details-label-closed">Show child attributes</span>')
      out.push(indent(pad + 6) + '<span class="api-details-label-open">Hide child attributes</span>')
      out.push(indent(pad + 4) + '</summary>')
      out.push(indent(pad + 4) + '<div class="api-child-fields">')
      out.push(...renderChildren(nested, pad + 6, new Set(trail).add(nested.name), depth + 1))
      out.push(indent(pad + 4) + '</div>')
      out.push(indent(pad + 2) + '</details>')
    }
    out.push(indent(pad) + '</div>')
  }
  return out
}

/** Renders one top-level attribute: anchored heading, prose, then its children. */
function renderField (owner, key, schema, options) {
  const pad = options.pad
  const id = options.idPrefix + slugify(key)
  const nested = objectBehind(schema)
  const description = describe(owner.name, key, schema)
  const out = []

  out.push(indent(pad) + '<div class="api-field' + (nested ? ' api-field-object' : '') + '" id="' + id + '">')
  out.push(indent(pad + 2) + '<div class="api-field-heading">')
  out.push(
    indent(pad + 4) +
      '<a class="api-anchor" href="#' + id + '" aria-label="Link to ' + escapeHtml(key) + '">#</a>'
  )
  out.push(indent(pad + 4) + '<code>' + escapeHtml(key) + '</code>')
  for (const tag of typeTags(schema, key, owner.required).split('\n')) out.push(indent(pad + 4) + tag)
  if (options.location) out.push(indent(pad + 4) + '<span class="api-in">' + options.location + '</span>')
  out.push(indent(pad + 2) + '</div>')
  if (description) out.push(indent(pad + 2) + '<p>' + escapeHtml(description) + '</p>')
  const limits = facets(schema)
  if (limits) out.push(indent(pad + 2) + limits)
  if (nested) {
    out.push(indent(pad + 2) + '<details class="api-schema-details">')
    out.push(indent(pad + 4) + '<summary>')
    out.push(indent(pad + 6) + '<span class="api-details-label-closed">Show child attributes</span>')
    out.push(indent(pad + 6) + '<span class="api-details-label-open">Hide child attributes</span>')
    out.push(indent(pad + 4) + '</summary>')
    out.push(indent(pad + 4) + '<div class="api-child-fields">')
    out.push(...renderChildren(nested, pad + 6, new Set([owner.name, nested.name]), 1))
    out.push(indent(pad + 4) + '</div>')
    out.push(indent(pad + 2) + '</details>')
  }
  out.push(indent(pad) + '</div>')
  return out
}

/** A parameter carries its own type and description rather than a schema owner. */
function renderParameter (parameter, pad) {
  const id = 'parameter-' + slugify(parameter.name)
  const out = []
  out.push(indent(pad) + '<div class="api-field" id="' + id + '">')
  out.push(indent(pad + 2) + '<div class="api-field-heading">')
  out.push(
    indent(pad + 4) +
      '<a class="api-anchor" href="#' + id + '" aria-label="Link to ' + escapeHtml(parameter.name) + '">#</a>'
  )
  out.push(indent(pad + 4) + '<code>' + escapeHtml(parameter.name) + '</code>')
  out.push(indent(pad + 4) + '<span class="api-type">' + (parameter.type || 'string') + '</span>')
  out.push(indent(pad + 4) + '<span class="api-in">' + parameter.in + '</span>')
  if (parameter.required) out.push(indent(pad + 4) + '<span class="api-required">required</span>')
  out.push(indent(pad + 2) + '</div>')
  if (parameter.description) out.push(indent(pad + 2) + '<p>' + escapeHtml(parameter.description) + '</p>')
  const limits = facets(parameter)
  if (limits) out.push(indent(pad + 2) + limits)
  out.push(indent(pad) + '</div>')
  return out
}

function section (title, id, pad, body) {
  return [
    indent(pad) + '<section class="api-section" aria-labelledby="' + id + '">',
    indent(pad + 2) + '<h2 id="' + id + '">' + title + '</h2>',
    ...body,
    indent(pad) + '</section>',
  ]
}

function renderAuthorizations (operation, pad) {
  const out = []
  for (const requirement of operation.security || []) {
    for (const name of Object.keys(requirement)) {
      const scheme = spec.securityDefinitions[name]
      if (!scheme) continue
      out.push(indent(pad + 2) + '<div class="api-field">')
      out.push(indent(pad + 4) + '<div class="api-field-heading">')
      out.push(indent(pad + 6) + '<code>' + escapeHtml(scheme.name) + '</code>')
      out.push(indent(pad + 6) + '<span class="api-type">string</span>')
      out.push(indent(pad + 6) + '<span class="api-in">' + scheme.in + '</span>')
      out.push(indent(pad + 6) + '<span class="api-required">required</span>')
      out.push(indent(pad + 4) + '</div>')
      out.push(
        indent(pad + 4) +
          '<p>' + escapeHtml(scheme.description) + '. Send the key in the <code>' +
          escapeHtml(scheme.name) + '</code> request ' + scheme.in + '.</p>'
      )
      out.push(indent(pad + 4) + '<a href="../create-api-key.html">Create an API key</a>')
      out.push(indent(pad + 2) + '</div>')
    }
  }
  return out.length ? section('Authorizations', 'api-authorizations-title', pad, out) : []
}

function renderParameterSection (parameters, location, title, pad) {
  const matching = parameters.filter((parameter) => parameter.in === location)
  if (!matching.length) return []
  const body = []
  for (const parameter of matching) body.push(...renderParameter(parameter, pad + 2))
  return section(title, 'api-' + location + '-parameters-title', pad, body)
}

function renderBodySection (parameters, pad) {
  const parameter = parameters.find((candidate) => candidate.in === 'body')
  if (!parameter) return []
  const owner = flatten(parameter.schema)
  const keys = Object.keys(owner.properties)
  if (!keys.length) return []
  const body = []
  for (const key of keys.sort()) {
    body.push(
      ...renderField(owner, key, owner.properties[key], { pad: pad + 2, idPrefix: 'body-' })
    )
  }
  return section('Body', 'api-body-title', pad, body)
}

function statusCodes (operation) {
  return Object.keys(operation.responses || {}).sort()
}

/** The status control is a menu only when there is more than one response. */
function renderStatusControl (codes, pad) {
  if (codes.length < 2) return [indent(pad) + '<span class="api-status-code">' + codes[0] + '</span>']
  const out = []
  out.push(indent(pad) + '<div class="api-status-picker">')
  out.push(
    indent(pad + 2) +
      '<button class="api-status-code api-status-toggle" type="button" aria-haspopup="menu" aria-expanded="false">'
  )
  out.push(indent(pad + 4) + '<span data-status-label>' + codes[0] + '</span>')
  out.push(indent(pad + 2) + '</button>')
  out.push(indent(pad + 2) + '<div class="api-status-menu" role="menu" hidden>')
  for (const code of codes) {
    out.push(
      indent(pad + 4) +
        '<button type="button" role="menuitemradio" aria-checked="' + (code === codes[0]) +
        '" data-response-status="' + code + '">' + code +
        '<span class="api-language-check" aria-hidden="true"></span></button>'
    )
  }
  out.push(indent(pad + 2) + '</div>')
  out.push(indent(pad) + '</div>')
  return out
}

function renderResponseSection (operation, pad) {
  const codes = statusCodes(operation)
  if (!codes.length) return []
  // A no-content response has no media type to advertise, whatever the
  // operation declares it produces.
  const returnsBody = codes.some((code) => (operation.responses[code] || {}).schema)
  const produces = returnsBody ? (operation.produces || ['application/json'])[0] : ''
  const out = []

  out.push(indent(pad) + '<section class="api-section api-response-section" aria-labelledby="api-response-title">')
  out.push(indent(pad + 2) + '<div class="api-response-heading">')
  out.push(indent(pad + 4) + '<h2 id="api-response-title">Response</h2>')
  out.push(indent(pad + 4) + '<div class="api-response-meta">')
  out.push(...renderStatusControl(codes, pad + 6))
  if (produces) out.push(indent(pad + 6) + '<span>' + produces + '</span>')
  out.push(indent(pad + 4) + '</div>')
  out.push(indent(pad + 2) + '</div>')

  for (const code of codes) {
    const schema = (operation.responses[code] || {}).schema
    const owner = schema ? flatten(schema) : { name: null, properties: {}, required: [] }
    const keys = Object.keys(owner.properties).sort()
    const prefix = codes.length > 1 ? 'response-' + code + '-' : 'response-'
    const body = []
    if (keys.length) {
      for (const key of keys) {
        body.push(...renderField(owner, key, owner.properties[key], { pad: pad + 4, idPrefix: prefix }))
      }
    } else {
      const note = (operation.responses[code] || {}).description || 'No content.'
      body.push(indent(pad + 4) + '<p class="api-empty-response">' + escapeHtml(note) + '</p>')
    }
    if (codes.length > 1) {
      out.push(
        indent(pad + 2) +
          '<div data-response-schema="' + code + '"' + (code === codes[0] ? '' : ' hidden') + '>'
      )
      out.push(...body)
      out.push(indent(pad + 2) + '</div>')
    } else {
      out.push(...body)
    }
  }
  out.push(indent(pad) + '</section>')
  return out
}

/** Builds a representative value so every page ships a response example. */
function sampleValue (schema, trail, depth) {
  const resolved = resolve(schema)
  if (resolved.allOf || (resolved.properties && Object.keys(resolved.properties).length)) {
    const owner = flatten(schema)
    if (trail.has(owner.name) || depth > MAX_EXAMPLE_DEPTH) return {}
    const next = new Set(trail).add(owner.name)
    const out = {}
    for (const key of Object.keys(owner.properties).sort()) {
      out[key] = sampleValue(owner.properties[key], next, depth + 1)
    }
    return out
  }
  if (resolved.type === 'array') {
    const item = objectBehind(resolved.items)
    if (item && (trail.has(item.name) || depth >= MAX_EXAMPLE_DEPTH)) return []
    return [sampleValue(resolved.items, trail, depth + 1)]
  }
  if (resolved.enum) return resolved.enum[0]
  if (resolved.type === 'boolean') return false
  if (resolved.type === 'integer' || resolved.type === 'number') return 0
  if (resolved.format === 'date-time') return '2026-01-01T00:00:00Z'
  return STRING_PLACEHOLDER
}

/**
 * Most operations declare the same envelope for success and failure, so the
 * schema alone cannot tell the two apart. The sample fills in the fields that
 * do differ: an error carries Error true with ErrorDetails and no Result, and a
 * success carries neither the flag nor the details.
 */
function asStatus (sample, code) {
  if (!sample || typeof sample !== 'object' || Array.isArray(sample)) return sample
  const failed = Number(code) >= 400
  const out = { ...sample }
  if ('Error' in out) out.Error = failed
  if ('ErrorDetails' in out && !failed) out.ErrorDetails = []
  if ('Result' in out && failed) delete out.Result
  return out
}

function responseExample (operation, code, slug) {
  const curated = (examples[slug] || {})[code]
  if (curated) return curated
  const schema = (operation.responses[code] || {}).schema
  if (!schema) return escapeHtml((operation.responses[code] || {}).description || 'No content')
  const sample = asStatus(sampleValue(schema, new Set(), 0), code)
  return escapeHtml(JSON.stringify(sample, null, 2))
}

function requestBodyJson (parameters) {
  const parameter = parameters.find((candidate) => candidate.in === 'body')
  if (!parameter) return null
  return JSON.stringify(sampleValue(parameter.schema, new Set(), MAX_EXAMPLE_DEPTH - 1), null, 2)
}

function reindent (value, pad) {
  return value.split('\n').join('\n' + ' '.repeat(pad))
}

function requestSample (language, method, url, body) {
  const key = '<your-api-key>'
  const verb = method.toUpperCase()
  switch (language) {
    case 'curl':
      return [
        'curl --request ' + verb + ' \\',
        "  --url '" + url + "' \\",
        "  --header 'x-api-key: " + key + "'" + (body ? ' \\' : ''),
        ...(body ? ["  --header 'Content-Type: application/json' \\", "  --data '" + reindent(body, 2) + "'"] : []),
      ].join('\n')
    case 'python':
      return [
        'import requests',
        '',
        'url = "' + url + '"',
        'headers = {"x-api-key": "' + key + '"}',
        ...(body ? ['payload = ' + body.replace(/\btrue\b/g, 'True').replace(/\bfalse\b/g, 'False'), ''] : []),
        'response = requests.' + method.toLowerCase() + '(url, headers=headers' + (body ? ', json=payload' : '') + ')',
        'print(response.json())',
      ].join('\n')
    case 'javascript':
      return [
        'const response = await fetch(',
        '  "' + url + '",',
        '  {',
        '    method: "' + verb + '",',
        '    headers: { "x-api-key": "' + key + '"' + (body ? ', "Content-Type": "application/json"' : '') + ' },',
        ...(body ? ['    body: JSON.stringify(' + reindent(body, 4) + '),'] : []),
        '  }',
        ')',
        'console.log(await response.json())',
      ].join('\n')
    case 'php':
      return [
        '<?php',
        '$request = curl_init(',
        '  "' + url + '"',
        ');',
        'curl_setopt($request, CURLOPT_CUSTOMREQUEST, "' + verb + '");',
        'curl_setopt($request, CURLOPT_HTTPHEADER, [',
        '  "x-api-key: ' + key + '"' + (body ? ',' : ''),
        ...(body ? ['  "Content-Type: application/json"'] : []),
        ']);',
        ...(body ? ['curl_setopt($request, CURLOPT_POSTFIELDS, \'' + reindent(body, 2) + "');"] : []),
        'curl_exec($request);',
      ].join('\n')
    case 'go':
      return [
        ...(body ? ['payload := strings.NewReader(`' + reindent(body, 2) + '`)', ''] : []),
        'request, _ := http.NewRequest(',
        '  "' + verb + '",',
        '  "' + url + '",',
        '  ' + (body ? 'payload' : 'nil') + ',',
        ')',
        'request.Header.Add("x-api-key", "' + key + '")',
        ...(body ? ['request.Header.Add("Content-Type", "application/json")'] : []),
        'response, _ := http.DefaultClient.Do(request)',
      ].join('\n')
    case 'java':
      return [
        'HttpRequest request = HttpRequest.newBuilder()',
        '  .uri(URI.create(',
        '    "' + url + '"',
        '  ))',
        '  .header("x-api-key", "' + key + '")',
        ...(body ? ['  .header("Content-Type", "application/json")'] : []),
        body
          ? '  .method("' + verb + '", HttpRequest.BodyPublishers.ofString("""\n' + reindent(body, 4) + '\n  """))'
          : '  .' + (verb === 'GET' || verb === 'DELETE' ? verb : 'method("' + verb + '", HttpRequest.BodyPublishers.noBody()') + '()',
        '  .build();',
      ].join('\n')
    case 'ruby':
      return [
        'uri = URI(',
        '  "' + url + '"',
        ')',
        'request = Net::HTTP::' + verb.charAt(0) + verb.slice(1).toLowerCase() + '.new(uri)',
        'request["x-api-key"] = "' + key + '"',
        ...(body ? ['request["Content-Type"] = "application/json"', "request.body = <<~JSON\n" + reindent(body, 2) + '\nJSON'] : []),
        'response = Net::HTTP.start(uri.host, uri.port, use_ssl: true) {',
        '  |http| http.request(request)',
        '}',
      ].join('\n')
    default:
      return ''
  }
}

function renderExamples (endpoint, operation, pad) {
  const url = BASE_URL + endpoint.path
  const body = requestBodyJson(operation.parameters || [])
  const codes = statusCodes(operation)
  const out = []

  out.push(indent(pad) + '<aside class="api-reference-examples" aria-label="Request and response examples">')
  out.push(indent(pad + 2) + '<section class="api-code-card api-request-example">')
  out.push(indent(pad + 4) + '<header class="api-code-header">')
  out.push(indent(pad + 6) + '<span class="api-code-title">' + escapeHtml(endpoint.label) + '</span>')
  out.push(indent(pad + 6) + '<div class="api-code-actions">')
  out.push(indent(pad + 8) + '<div class="api-language-picker">')
  out.push(
    indent(pad + 10) +
      '<button class="api-language-toggle" type="button" aria-haspopup="menu" aria-expanded="false">'
  )
  out.push(indent(pad + 12) + '<span class="api-language-icon" data-language-icon="curl" aria-hidden="true"></span>')
  out.push(indent(pad + 12) + '<span data-language-label>cURL</span>')
  out.push(indent(pad + 12) + '<span class="api-chevron" aria-hidden="true"></span>')
  out.push(indent(pad + 10) + '</button>')
  out.push(indent(pad + 10) + '<div class="api-language-menu" role="menu" hidden>')
  for (const [id, label] of LANGUAGES) {
    out.push(
      indent(pad + 12) +
        '<button type="button" role="menuitemradio" aria-checked="' + (id === 'curl') +
        '" data-language="' + id + '"><span class="api-language-icon" data-language-icon="' + id +
        '" aria-hidden="true"></span>' + label + '<span class="api-language-check" aria-hidden="true"></span></button>'
    )
  }
  out.push(indent(pad + 10) + '</div>')
  out.push(indent(pad + 8) + '</div>')
  out.push(
    indent(pad + 8) +
      '<button class="api-icon-button api-copy" type="button" data-copy-active-pane="request" aria-label="Copy request example">'
  )
  out.push(indent(pad + 10) + '<span class="api-copy-icon" aria-hidden="true"></span>')
  out.push(indent(pad + 10) + '<span class="api-copy-status" role="status"></span>')
  out.push(indent(pad + 8) + '</button>')
  out.push(indent(pad + 6) + '</div>')
  out.push(indent(pad + 4) + '</header>')
  out.push(indent(pad + 4) + '<div class="api-code-body">')
  for (const [id, , highlight] of LANGUAGES) {
    out.push(
      indent(pad + 6) + '<pre data-request-language="' + id + '"' + (id === 'curl' ? '' : ' hidden') +
        '><code class="hljs language-' + highlight + '">' +
        escapeHtml(requestSample(id, endpoint.method, url, body)) + '</code></pre>'
    )
  }
  out.push(indent(pad + 4) + '</div>')
  out.push(indent(pad + 2) + '</section>')

  out.push(indent(pad + 2) + '<section class="api-code-card api-response-example">')
  out.push(indent(pad + 4) + '<header class="api-code-header">')
  out.push(indent(pad + 6) + '<div class="api-response-tabs" role="tablist" aria-label="Response status">')
  for (const code of codes) {
    out.push(
      indent(pad + 8) + '<button type="button" role="tab" aria-selected="' + (code === codes[0]) +
        '" tabindex="' + (code === codes[0] ? '0' : '-1') + '" data-response-status="' + code + '">' + code + '</button>'
    )
  }
  out.push(indent(pad + 6) + '</div>')
  out.push(indent(pad + 6) + '<div class="api-code-actions">')
  out.push(
    indent(pad + 6) +
      '  <button class="api-icon-button api-copy" type="button" data-copy-active-pane="response" aria-label="Copy response example">'
  )
  out.push(indent(pad + 10) + '<span class="api-copy-icon" aria-hidden="true"></span>')
  out.push(indent(pad + 10) + '<span class="api-copy-status" role="status"></span>')
  out.push(indent(pad + 8) + '</button>')
  out.push(indent(pad + 6) + '</div>')
  out.push(indent(pad + 4) + '</header>')
  out.push(indent(pad + 4) + '<div class="api-code-body">')
  for (const code of codes) {
    out.push(
      indent(pad + 6) + '<pre role="tabpanel" data-response-pane="' + code + '"' +
        (code === codes[0] ? '' : ' hidden') + '><code class="hljs language-json">' +
        responseExample(operation, code, endpoint.slug) + '</code></pre>'
    )
  }
  out.push(indent(pad + 4) + '</div>')
  out.push(indent(pad + 2) + '</section>')
  out.push(indent(pad) + '</aside>')
  return out
}

function operationFor (endpoint) {
  const operation = (spec.paths[endpoint.path] || {})[endpoint.method.toLowerCase()]
  if (!operation) throw new Error('no spec entry for ' + endpoint.method + ' ' + endpoint.path)
  return operation
}

function renderApiPage (endpoint) {
  const operation = operationFor(endpoint)
  const parameters = operation.parameters || []
  const intro = lead(endpoint, operation)
  const out = []

  out.push('<div class="api-reference-page" data-api-reference>')
  if (intro) out.push('  <p class="api-lead">' + escapeHtml(intro.replace(/\.?$/, '.')) + '</p>')
  out.push('')
  out.push('  <div class="api-reference-layout">')
  out.push('    <div class="api-reference-main">')
  out.push('      <div class="api-endpoint-bar">')
  out.push('        <div class="api-endpoint-path">')
  out.push(
    '          <span class="api-method api-method-' + endpoint.method.toLowerCase() + '">' + endpoint.method + '</span>'
  )
  out.push('          <code id="api-endpoint-path">' + escapeHtml(endpoint.path) + '</code>')
  out.push(
    '        </div>\n' +
      '        <button class="api-icon-button api-copy" type="button" data-copy-target="api-endpoint-path" aria-label="Copy endpoint path">\n' +
      '          <span class="api-copy-icon" aria-hidden="true"></span>\n' +
      '          <span class="api-copy-status" role="status"></span>\n' +
      '        </button>'
  )
  out.push('      </div>')
  out.push('')
  out.push(...renderAuthorizations(operation, 6))
  out.push(...renderParameterSection(parameters, 'path', 'Path parameters', 6))
  out.push(...renderParameterSection(parameters, 'query', 'Query parameters', 6))
  out.push(...renderParameterSection(parameters, 'header', 'Header parameters', 6))
  out.push(...renderBodySection(parameters, 6))
  out.push(...renderResponseSection(operation, 6))
  out.push('    </div>')
  out.push('')
  out.push(...renderExamples(endpoint, operation, 4))
  out.push('  </div>')
  out.push('</div>')
  return out.join('\n')
}

module.exports = { renderApiPage }
