const { SQLService } = require('@cap-js/db-service')
const cds = require('@sap/cds')
const { Database } = require('@sqlitecloud/drivers')
const $session = Symbol('dbc.session')
const sessionVariableMap = require('./session.json')  // Adjust the path as necessary for your project
const convStrm = require('stream/consumers')
const { Readable } = require('stream')

const keywords = cds.compiler.to.sql.sqlite.keywords
// keywords come as array
const sqliteKeywords = keywords.reduce((prev, curr) => {
  prev[curr] = 1
  return prev
}, {})

// define date and time functions in js to allow for throwing errors
const isTime = /^\d{1,2}:\d{1,2}:\d{1,2}$/
const hasTimezone = /([+-]\d{1,2}:?\d{0,2}|Z)$/
const toDate = (d, allowTime = false) => {
  const date = new Date(allowTime && isTime.test(d) ? `1970-01-01T${d}Z` : hasTimezone.test(d) ? d : d + 'Z')
  if (Number.isNaN(date.getTime())) throw new Error(`Value does not contain a valid ${allowTime ? 'time' : 'date'} "${d}"`)
  return date
}


class SQLiteCloudService extends SQLService {

  get factory() {
    return {
      options: this.options.pool || {},
      create: tenant => {
        const connectionString = this.url4(tenant)
        const dbc = new Database(connectionString)

        // NOTE: @sqlitecloud/drivers doesn't support dbc.function() like better-sqlite3
        // Custom functions like session_context, regexp, ISO, year, month, day, hour, minute, second
        // need to be registered server-side in SQLite Cloud or implemented via SQLite-JS extension
        // See: https://docs.sqlitecloud.io/docs/sqlite-js

        // Store session data on the connection object
        dbc[$session] = {}

        return dbc
      },
      destroy: dbc => dbc.close(),
      validate: dbc => !!dbc,
    }
  }

  url4(tenant) {
    let { url, database: db = url, connectionString } = this.options.credentials || this.options || {}

    // If connectionString is provided, use it directly
    if (connectionString) {
      return tenant ? connectionString.replace(/\/([^\/]+)(\?|$)/, `/${tenant}$2`) : connectionString
    }

    // Otherwise use url/database
    if (!db) {
      throw new Error('SQLite Cloud requires a connection string or database URL in credentials')
    }

    return tenant ? db.replace(/\/([^\/]+)(\?|$)/, `/${tenant}$2`) : db
  }

  set(variables) {
    const dbc = this.dbc || cds.error('Cannot set session context: No database connection')

    // Enrich provided session context with aliases
    for (const alias in sessionVariableMap) {
      const name = sessionVariableMap[alias]
      if (variables[name]) variables[alias] = variables[name]
    }

    if (!dbc[$session]) dbc[$session] = variables
    else Object.assign(dbc[$session], variables)
  }

  release() {
    this.dbc[$session] = undefined
    return super.release()
  }

  prepare(sql) {
    try {
      // @sqlitecloud/drivers doesn't have prepare() like better-sqlite3
      // Instead, we wrap database.sql() calls in a compatible interface
      const dbc = this.dbc
      return {
        run: async (binding_params) => {
          const result = await this._run(sql, binding_params)
          return result
        },
        get: async (binding_params) => {
          const rows = await dbc.sql(sql, ...binding_params)
          return rows[0]
        },
        all: async (binding_params) => {
          const rows = await dbc.sql(sql, ...binding_params)
          return rows
        },
        stream: (..._) => this._allStream(sql, ..._),
      }
    } catch (e) {
      e.message += ' in:\n' + (e.query = sql)
      throw e
    }
  }

  async _run(sql, binding_params) {
    // Process streams and buffers in binding parameters
    for (let i = 0; i < binding_params.length; i++) {
      const val = binding_params[i]
      if (val instanceof Readable) {
        binding_params[i] = await convStrm[val.type === 'json' ? 'text' : 'buffer'](val)
      }
      if (Buffer.isBuffer(val)) {
        binding_params[i] = Buffer.from(val.toString('base64'))
      }
    }

    // Execute the query using database.sql()
    await this.dbc.sql(sql, ...binding_params)

    // Return an object compatible with better-sqlite3's run result
    // Note: SQLite Cloud may not provide affected row count in the same way
    return { changes: 1, lastInsertRowid: undefined }
  }

  async *_iteratorRaw(rs, one) {
    const pageSize = (1 << 16)
    // Allow for both array and iterator result sets
    const first = Array.isArray(rs) ? { done: !rs[0], value: rs[0] } : rs.next()
    if (first.done) return
    if (one) {
      yield first.value[0]
      // Close result set to release database connection
      rs.return()
      return
    }

    let buffer = '[' + first.value[0]
    // Print first value as stand alone to prevent comma check inside the loop
    for (const row of rs) {
      buffer += `,${row[0]}`
      if (buffer.length > pageSize) {
        yield buffer
        buffer = ''
      }
    }
    buffer += ']'
    yield buffer
  }

  async *_iteratorObjectMode(rs) {
    for (const row of rs) {
      yield JSON.parse(row[0])
    }
  }

  async _allStream(sql, binding_params, one, objectMode) {
    // @sqlitecloud/drivers returns arrays, not iterators
    // So we fetch all results and then stream them
    const rows = await this.dbc.sql(sql, ...binding_params)

    if (!rows || rows.length === 0) return []

    // Convert rows to the format expected by the iterator
    const rs = rows.map(row => [JSON.stringify(row)])

    const stream = Readable.from(objectMode ? this._iteratorObjectMode(rs) : this._iteratorRaw(rs, one), { objectMode })
    return stream
  }

  async pragma(pragma, options) {
    // @sqlitecloud/drivers doesn't have pragma() method
    // Execute pragma as SQL statement
    if (!this.dbc) return this.begin('pragma').then(tx => {
      try { return tx.pragma(pragma, options) }
      finally { tx.release() }
    })

    const sql = options !== undefined ? `PRAGMA ${pragma} = ${options}` : `PRAGMA ${pragma}`
    return await this.dbc.sql(sql)
  }


  async exec(sql) {
    // @sqlitecloud/drivers doesn't have exec() method
    // Use sql() instead
    return await this.dbc.sql(sql)
  }

  _prepareStreams(values) {
    let any
    values.forEach((v, i) => {
      if (v instanceof Readable) {
        any = values[i] = convStrm.buffer(v)
      }
    })
    return any ? Promise.all(values) : values
  }

  async onSIMPLE({ query, data }) {
    const { sql, values } = this.cqn2sql(query, data)
    let ps = await this.prepare(sql)
    const vals = await this._prepareStreams(values)
    return (await ps.run(vals)).changes
  }

  onPlainSQL({ query, data }, next) {
    if (typeof query === 'string') {
      // REVISIT: this is a hack the target of $now might not be a timestamp or date time
      // Add input converter to CURRENT_TIMESTAMP inside views using $now
      if (/^CREATE VIEW.* CURRENT_TIMESTAMP[( ]/is.test(query)) {
        query = query.replace(/CURRENT_TIMESTAMP/gi, "STRFTIME('%Y-%m-%dT%H:%M:%fZ','NOW')")
      }
    }
    return super.onPlainSQL({ query, data }, next)
  }

  static CQN2SQL = class CQN2SQLiteCloud extends SQLService.CQN2SQL {
    column_alias4(x, q) {
      let alias = super.column_alias4(x, q)
      if (alias) return alias
      if (x.ref) {
        let obm = q._orderByMap
        if (!obm) {
          Object.defineProperty(q, '_orderByMap', { value: (obm = {}) })
          q.SELECT?.orderBy?.forEach(o => {
            if (o.ref?.length === 1) obm[o.ref[0]] = o.ref[0]
          })
        }
        return obm[x.ref.at(-1)]
      }
    }

    val(v) {
      if (typeof v.val === 'boolean') v.val = v.val ? 1 : 0
      else if (Buffer.isBuffer(v.val)) v.val = v.val.toString('base64')
      // intercept DateTime values and convert to Date objects to compare ISO Strings
      else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(.\d{1,9})?(Z|[+-]\d{2}(:?\d{2})?)$/.test(v.val)) {
        const date = new Date(v.val)
        if (!Number.isNaN(date.getTime())) {
          v.val = date
        }
      }
      return super.val(v)
    }

    forUpdate() {
      return ''
    }

    forShareLock() {
      return ''
    }

    // Used for INSERT statements
    static InputConverters = {
      ...super.InputConverters,
      // The following allows passing in ISO strings with non-zulu
      // timezones and converts them into zulu dates and times
      Date: e => e === '?' ? e : `strftime('%Y-%m-%d',${e})`,
      Time: e => e === '?' ? e : `strftime('%H:%M:%S',${e})`,
      // Both, DateTimes and Timestamps are canonicalized to ISO strings with
      // ms precision to allow safe comparisons, also to query {val}s in where clauses
      // NOTE: Using strftime instead of custom ISO() function which isn't available
      DateTime: e => e === '?' ? e : `strftime('%Y-%m-%dT%H:%M:%fZ',${e})`,
      Timestamp: e => e === '?' ? e : `strftime('%Y-%m-%dT%H:%M:%fZ',${e})`,
    }

    static OutputConverters = {
      ...super.OutputConverters,
      // Structs and arrays are stored as JSON strings; the ->'$' unwraps them.
      // Otherwise they would be added as strings to json_objects.
      Association: expr => `${expr}->'$'`,
      struct: expr => `${expr}->'$'`,
      array: expr => `${expr}->'$'`,
      // SQLite has no booleans so we need to convert 0 and 1
      boolean:
        cds.env.features.sql_simple_queries === 2
          ? undefined
          : expr => `CASE ${expr} when 1 then 'true' when 0 then 'false' END ->'$'`,
      // DateTimes are returned without ms added by InputConverters
      DateTime: e => `substr(${e},0,20)||'Z'`,
      // Timestamps are returned with ms, as written by InputConverters.
      // And as cds.builtin.classes.Timestamp inherits from DateTime we need
      // to override the DateTime converter above
      Timestamp: undefined,
      // int64 is stored as native int64 for best comparison
      // Reading int64 as string to not loose precision
      Int64: cds.env.features.ieee754compatible ? expr => `CAST(${expr} as TEXT)` : undefined,
      // REVISIT: always cast to string in next major
      // Reading decimal as string to not loose precision
      Decimal: cds.env.features.ieee754compatible ? (expr, elem) => elem?.scale
        ? `CASE WHEN ${expr} IS NULL THEN NULL ELSE format('%.${elem.scale}f', ${expr}) END`
        : `CAST(${expr} as TEXT)`
        : undefined,
      // Binary is not allowed in json objects
      Binary: expr => `${expr} || ''`,
    }

    // Used for SQL function expressions
    static Functions = { ...super.Functions, ...require('./cql-functions') }

    // Used for CREATE TABLE statements
    static TypeMap = {
      ...super.TypeMap,
      Binary: e => `BINARY_BLOB(${e.length || 5000})`,
      Date: () => 'DATE_TEXT',
      Time: () => 'TIME_TEXT',
      DateTime: () => 'DATETIME_TEXT',
      Timestamp: () => 'TIMESTAMP_TEXT',
      Map: () => 'JSON_TEXT'
    }

    get is_distinct_from_() {
      return 'is not'
    }
    get is_not_distinct_from_() {
      return 'is'
    }

    static ReservedWords = { ...super.ReservedWords, ...sqliteKeywords }
  }
}

module.exports = SQLiteCloudService
