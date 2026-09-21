'use strict'

/**
 * Builds a Postman Collection v2.1 from the public Savanna REST endpoints.
 */

const fs = require('fs')
const path = require('path')
const { requestBodyJson } = require('./api-page')

const SPEC = path.join(__dirname, '..', 'modules/savanna/modules/rest-api/_catalog/openapi.json')
const OUT = path.join(
  __dirname,
  '..',
  'modules/savanna/modules/rest-api/assets/attachments/savanna-rest-api.postman_collection.json'
)

const COLLECTION_ID = '7c4e1b2a-9d83-4f0e-a6c1-8b2d4e6f90ab'
const BASE_URL = 'https://api.tgcloud.io'

function operationFor (spec, endpoint) {
  const operation = (spec.paths[endpoint.path] || {})[endpoint.method.toLowerCase()]
  if (!operation) throw new Error('no spec entry for ' + endpoint.method + ' ' + endpoint.path)
  return operation
}

function segmentPath (route) {
  return String(route)
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      const param = /^\{(.+)\}$/.exec(segment)
      return param ? ':' + param[1] : segment
    })
}

function pathVariables (parameters) {
  return parameters
    .filter((parameter) => parameter.in === 'path')
    .map((parameter) => ({
      key: parameter.name,
      value: '{{' + parameter.name + '}}',
      description: parameter.description || '',
    }))
}

function queryParams (parameters) {
  return parameters
    .filter((parameter) => parameter.in === 'query')
    .map((parameter) => ({
      key: parameter.name,
      value: parameter.default != null ? String(parameter.default) : '{{' + parameter.name + '}}',
      description: parameter.description || '',
      disabled: !parameter.required,
    }))
}

function extraHeaders (parameters) {
  return parameters
    .filter((parameter) => parameter.in === 'header' && parameter.name.toLowerCase() !== 'x-api-key')
    .map((parameter) => ({
      key: parameter.name,
      value: '{{' + parameter.name + '}}',
      type: 'text',
      description: parameter.description || '',
    }))
}

function collectVariableKeys (endpoints) {
  const keys = new Set(['baseUrl', 'apiKey'])
  for (const endpoint of endpoints) {
    for (const match of endpoint.path.matchAll(/\{([^}]+)\}/g)) keys.add(match[1])
  }
  return [...keys]
}

function requestItem (spec, endpoint) {
  const operation = operationFor(spec, endpoint)
  const parameters = operation.parameters || []
  const rawPath = endpoint.path.replace(/\{([^}]+)\}/g, ':$1')
  const url = {
    raw: '{{baseUrl}}' + rawPath,
    host: ['{{baseUrl}}'],
    path: segmentPath(endpoint.path),
  }
  const pathVars = pathVariables(parameters)
  const query = queryParams(parameters)
  if (pathVars.length) url.variable = pathVars
  if (query.length) url.query = query

  const request = {
    method: endpoint.method,
    header: extraHeaders(parameters),
    url,
    description: operation.description || operation.summary || endpoint.label,
  }

  const usesApiKey = (operation.security || []).some((entry) => Object.prototype.hasOwnProperty.call(entry, 'ApiKeyAuth'))
  if (!usesApiKey) request.auth = { type: 'noauth' }

  const body = requestBodyJson(parameters)
  if (body) {
    request.header = request.header.concat({ key: 'Content-Type', value: 'application/json', type: 'text' })
    request.body = { mode: 'raw', raw: body, options: { raw: { language: 'json' } } }
  }

  return { name: endpoint.label, request }
}

function writePostmanCollection (grouped) {
  const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'))
  const endpoints = []
  const folders = []
  for (const [name, items] of grouped) {
    if (!items.length) continue
    folders.push({
      name,
      item: items.map((endpoint) => {
        endpoints.push(endpoint)
        return requestItem(spec, endpoint)
      }),
    })
  }

  const collection = {
    info: {
      _postman_id: COLLECTION_ID,
      name: 'TigerGraph Savanna REST API',
      description:
        'Control-plane endpoints for TigerGraph Savanna (' +
        BASE_URL +
        '). Set apiKey to your Savanna API key (x-api-key). Org user endpoints do not accept API keys.',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    auth: {
      type: 'apikey',
      apikey: [
        { key: 'key', value: 'x-api-key', type: 'string' },
        { key: 'value', value: '{{apiKey}}', type: 'string' },
        { key: 'in', value: 'header', type: 'string' },
      ],
    },
    variable: collectVariableKeys(endpoints).map((key) => ({
      key,
      value: key === 'baseUrl' ? BASE_URL : '',
    })),
    item: folders,
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(collection, null, 2) + '\n')
  return OUT
}

module.exports = { writePostmanCollection }
