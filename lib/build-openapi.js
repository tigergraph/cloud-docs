'use strict'

/**
 * Writes the customer-facing OpenAPI 3 document for the Savanna REST API
 * reference.
 *
 * The service catalog (modules/savanna/modules/rest-api/_catalog/openapi.json)
 * is Swagger 2 and includes routes the reference does not publish. This script
 * keeps the public allowlist in lib/split-endpoints.js, converts those
 * operations to OpenAPI 3, and fills attribute prose from lib/api-descriptions.json.
 *
 * Usage: node lib/build-openapi.js
 */

const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')
const { LABELS, GROUPS, slugify } = require('./split-endpoints')

const ROOT = path.join(__dirname, '..')
const SPEC_PATH = path.join(ROOT, 'modules/savanna/modules/rest-api/_catalog/openapi.json')
const DESCRIPTIONS_PATH = path.join(__dirname, 'api-descriptions.json')
const EXAMPLES_PATH = path.join(__dirname, 'api-examples.json')
const OUT_PATH = path.join(ROOT, 'modules/savanna/modules/rest-api/attachments/openapi.yaml')

const DOCS_BASE = 'https://www.tigergraph.com/docs/savanna/main/rest-api/endpoints/'

const TAG_DESCRIPTIONS = {
  'Cloud providers': 'TigerGraph-operated providers, and Bring Your Own Cloud accounts registered to the organization.',
  Workgroups: 'Containers for workspaces. A workgroup selects the cloud provider, region, and access boundary.',
  Workspaces: 'Compute that runs a graph. Creating a workspace also creates its database.',
  'Add-ons': 'Add-ons available to the organization, such as GraphStudio, Insights, and GraphQL, and the workspaces they attach to.',
  'Workspace schedules': 'Recurring schedules that pause and resume a workspace.',
  Databases: 'The database attached to a workspace. A database is created with its workspace.',
  Backups: 'Workspace backups, restore jobs, and the backup schedule. A backup schedule is separate from a workspace schedule.',
  'IP allow list': 'IP addresses and CIDR ranges permitted to reach a workgroup.',
  'In-database users': 'GSQL users inside a workspace.',
  Organization: 'Workspace options available to the organization, and the users in it.',
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete']

function readJson (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function clean (value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value
}

function operationId (slug) {
  return slug.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
}

/** Copies a Swagger 2 schema into an OpenAPI 3 schema and rewrites definition refs. */
function convertSchema (schema) {
  if (!schema || typeof schema !== 'object') return schema
  if (Array.isArray(schema)) return schema.map(convertSchema)
  if (schema.$ref) {
    return { $ref: schema.$ref.replace('#/definitions/', '#/components/schemas/') }
  }

  const out = {}
  const copy = [
    'type', 'format', 'enum', 'default', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
    'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems', 'example', 'required',
  ]
  for (const key of copy) {
    if (schema[key] !== undefined) out[key] = schema[key]
  }
  if (schema.description) out.description = clean(schema.description)
  if (schema['x-nullable']) out.nullable = true
  if (schema.properties) {
    out.properties = {}
    for (const [name, value] of Object.entries(schema.properties)) {
      out.properties[name] = convertSchema(value)
    }
  }
  if (schema.items) out.items = convertSchema(schema.items)
  if (schema.additionalProperties !== undefined) {
    out.additionalProperties = typeof schema.additionalProperties === 'boolean'
      ? schema.additionalProperties
      : convertSchema(schema.additionalProperties)
  }
  for (const key of ['allOf', 'oneOf', 'anyOf']) {
    if (schema[key]) out[key] = schema[key].map(convertSchema)
  }
  return out
}

function applyDescriptions (name, schema, descriptions) {
  const prose = descriptions[name]
  if (!prose || !schema.properties) return schema
  for (const [key, property] of Object.entries(schema.properties)) {
    if (!property.description && prose[key]) property.description = prose[key]
  }
  return schema
}

function parameterSchema (parameter) {
  if (parameter.schema) return convertSchema(parameter.schema)
  const schema = {}
  for (const key of ['type', 'format', 'enum', 'default', 'minimum', 'maximum', 'pattern']) {
    if (parameter[key] !== undefined) schema[key] = parameter[key]
  }
  if (parameter.items) schema.items = convertSchema(parameter.items)
  if (parameter['x-nullable']) schema.nullable = true
  return schema
}

function collectRefs (node, refs) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach((item) => collectRefs(item, refs))
    return
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string' && value.startsWith('#/components/schemas/')) {
      refs.add(value.slice('#/components/schemas/'.length))
    } else {
      collectRefs(value, refs)
    }
  }
}

function build () {
  const swagger = readJson(SPEC_PATH)
  const descriptions = readJson(DESCRIPTIONS_PATH)
  const examples = readJson(EXAMPLES_PATH)
  const groupTitles = new Map(GROUPS)

  const paths = {}
  const usedTags = []
  const seenTags = new Set()

  for (const [request, label] of Object.entries(LABELS)) {
    const space = request.indexOf(' ')
    const method = request.slice(0, space).toLowerCase()
    const urlPath = request.slice(space + 1)
    const operation = (swagger.paths[urlPath] || {})[method]
    if (!operation) throw new Error('no catalog operation for ' + request)
    if (!HTTP_METHODS.includes(method)) throw new Error('unsupported method ' + request)

    const tag = (operation.tags || [])[0]
    const group = groupTitles.get(tag)
    if (!group) throw new Error('unmapped tag "' + tag + '" for ' + request)
    if (!seenTags.has(group)) {
      seenTags.add(group)
      usedTags.push(group)
    }

    const slug = slugify(label)
    const converted = {
      tags: [group],
      summary: label,
      operationId: operationId(slug),
      externalDocs: {
        description: label,
        url: DOCS_BASE + slug,
      },
    }
    const lead = (descriptions._operations || {})[request] || clean(operation.description)
    if (lead && lead !== label) converted.description = lead

    const parameters = []
    for (const parameter of operation.parameters || []) {
      if (parameter.in === 'body') {
        if (converted.requestBody) throw new Error('multiple body parameters for ' + request)
        converted.requestBody = {
          required: parameter.required !== false,
          content: {
            'application/json': { schema: convertSchema(parameter.schema || {}) },
          },
        }
        if (parameter.description) {
          converted.requestBody = {
            description: clean(parameter.description),
            required: converted.requestBody.required,
            content: converted.requestBody.content,
          }
        }
        continue
      }
      if (!['path', 'query', 'header'].includes(parameter.in)) {
        throw new Error('unsupported parameter location ' + parameter.in + ' on ' + request)
      }
      const entry = {
        name: parameter.name,
        in: parameter.in,
        required: parameter.in === 'path' ? true : Boolean(parameter.required),
        schema: parameterSchema(parameter),
      }
      if (parameter.description) entry.description = clean(parameter.description)
      parameters.push(entry)
    }
    if (parameters.length) converted.parameters = parameters

    converted.responses = {}
    const samples = examples[slug] || {}
    for (const [status, response] of Object.entries(operation.responses || {})) {
      const entry = { description: clean(response.description) || status }
      if (response.schema || samples[status]) {
        const media = {}
        if (response.schema) media.schema = convertSchema(response.schema)
        if (samples[status]) media.example = JSON.parse(samples[status])
        entry.content = { 'application/json': media }
      }
      converted.responses[status] = entry
    }
    if (!Object.keys(converted.responses).length) {
      converted.responses.default = { description: 'Response' }
    }

    if (!paths[urlPath]) paths[urlPath] = {}
    paths[urlPath][method] = converted
  }

  const refs = new Set()
  collectRefs(paths, refs)
  const schemas = {}
  const pending = [...refs]
  while (pending.length) {
    const name = pending.pop()
    if (schemas[name]) continue
    const definition = swagger.definitions[name]
    if (!definition) throw new Error('missing definition ' + name)
    const schema = applyDescriptions(name, convertSchema(definition), descriptions)
    schemas[name] = schema
    const nested = new Set()
    collectRefs(schema, nested)
    for (const child of nested) {
      if (!schemas[child]) pending.push(child)
    }
  }

  const orderedSchemas = {}
  for (const name of Object.keys(schemas).sort()) orderedSchemas[name] = schemas[name]

  const document = {
    openapi: '3.0.3',
    info: {
      title: 'TigerGraph Savanna REST API',
      version: 'v4',
      description: [
        'Control-plane API for TigerGraph Savanna. Use it to provision workgroups and workspaces, manage cloud providers and add-ons, protect data with backups, control network access, and administer an organization.',
        '',
        'Every request needs an API key in the `x-api-key` header. An organization administrator creates the key in Savanna under Admin, Settings.',
        '',
        'Paths are relative to `https://api.tgcloud.io`. Most routes live under `/controller/v4/v2`. Organization user routes are `/users` and `/users/{userId}/roles`.',
        '',
        'This document is the customer-facing API reference. To read and write graph data inside a workspace, call that workspace host with the GSQL and REST++ endpoints.',
      ].join('\n'),
      contact: {
        name: 'TigerGraph Savanna API reference',
        url: 'https://www.tigergraph.com/docs/savanna/main/rest-api/',
      },
    },
    servers: [
      {
        url: 'https://api.tgcloud.io',
        description: 'Savanna control plane',
      },
    ],
    tags: usedTags.map((name) => ({ name, description: TAG_DESCRIPTIONS[name] })),
    security: [{ ApiKeyAuth: [] }],
    paths,
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'x-api-key',
          description: 'API key for TigerGraph Savanna. Send the key in the `x-api-key` request header. Only an organization administrator can create one.',
        },
      },
      schemas: orderedSchemas,
    },
  }

  const missingTagCopy = usedTags.filter((name) => !TAG_DESCRIPTIONS[name])
  if (missingTagCopy.length) throw new Error('missing tag descriptions: ' + missingTagCopy.join(', '))

  const banner = [
    '# Generated by lib/build-openapi.js. Do not edit.',
    '# Public Savanna REST API reference. The source catalog is Swagger 2 and',
    '# includes unpublished routes; this file keeps the allowlist in lib/split-endpoints.js.',
    '',
  ].join('\n')

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true })
  fs.writeFileSync(OUT_PATH, banner + yaml.dump(document, { lineWidth: 100, noRefs: true, sortKeys: false }))

  const operations = Object.values(paths).reduce((count, item) => count + Object.keys(item).length, 0)
  console.log('wrote ' + OUT_PATH)
  console.log(operations + ' operations, ' + Object.keys(orderedSchemas).length + ' schemas')
}

build()
