# CDS database service for SQLite Cloud

Welcome to the SQLite Cloud database service for [SAP Cloud Application Programming Model](https://cap.cloud.sap) Node.js, based on streamlined database architecture and [*@sqlitecloud/drivers*](https://www.npmjs.com/package/@sqlitecloud/drivers).

## Setup

If you want to use SQLite Cloud for your application, install the database package as follows:

```sh
npm add @cap-js/sqlitecloud
```

## Configuration

Configure your connection in your `package.json` or `.cdsrc.json`:

```json
{
  "cds": {
    "requires": {
      "db": {
        "kind": "sqlitecloud",
        "credentials": {
          "connectionString": "sqlitecloud://user:password@host.sqlite.cloud:8860/database"
        }
      }
    }
  }
}
```

Alternatively, you can use environment variables or a `.env` file:

```env
CDS_REQUIRES_DB_KIND=sqlitecloud
CDS_REQUIRES_DB_CREDENTIALS_CONNECTIONSTRING=sqlitecloud://user:password@host.sqlite.cloud:8860/database
```

## Connection String Format

The SQLite Cloud connection string follows this format:

```
sqlitecloud://user:password@host:port/database?timeout=10000
```

- **user**: Your SQLite Cloud username
- **password**: Your SQLite Cloud password
- **host**: Your SQLite Cloud hostname
- **port**: SQLite Cloud port (default: 8860)
- **database**: Database name
- **timeout**: Optional connection timeout in milliseconds

## Features

This plugin provides SQLite compatibility with the added benefits of SQLite Cloud:

- Cloud-hosted SQLite databases
- Multi-tenant support
- Concurrent access
- Automatic backups
- High availability

## Known Limitations

### Custom Functions

The `@sqlitecloud/drivers` package does not support client-side custom function registration like `better-sqlite3`. This means certain advanced CDS features that rely on custom SQL functions may require server-side implementation:

- **session_context()** - Used for session variable access
- **regexp** - Used for regular expression matching
- **Custom date/time functions** - year(), month(), day(), hour(), minute(), second()

#### Solutions:

1. **Use SQLite-JS Extension**: Register custom functions server-side using the [SQLite-JS extension](https://docs.sqlitecloud.io/docs/sqlite-js)
2. **Fallback to Built-in Functions**: The plugin automatically uses SQLite's built-in `strftime()` for date/time operations where possible
3. **Limited Feature Set**: Some CAP features may not work without server-side function registration

### API Differences

Unlike the `@cap-js/sqlite` plugin which uses `better-sqlite3` (synchronous), this plugin uses `@sqlitecloud/drivers` (asynchronous). This means:

- All database operations are Promise-based
- Streaming may fetch all results before streaming (not ideal for very large result sets)
- Some performance characteristics differ from local SQLite

## Registering Server-Side Functions (Optional)

If your application requires advanced features like session context or regular expressions, you'll need to register custom functions server-side using SQLite-JS:

```javascript
// Example: Registering the regexp function in SQLite Cloud
// This would be done server-side, not in your Node.js application

CREATE FUNCTION regexp(pattern TEXT, str TEXT) RETURNS INTEGER
LANGUAGE JAVASCRIPT
AS $$
  return RegExp(pattern).test(str) ? 1 : 0;
$$;
```

For more information on registering server-side functions, see the [SQLite Cloud SQLite-JS documentation](https://docs.sqlitecloud.io/docs/sqlite-js).

## Support

This project is open to feature requests/suggestions, bug reports etc. via [GitHub issues](https://github.com/cap-js/cds-dbs/issues).

## Contribution

Contribution and feedback are encouraged and always welcome. For more information about how to contribute, the project structure, as well as additional contribution information, see our [Contribution Guidelines](CONTRIBUTING.md).

## Versioning

This library follows [Semantic Versioning](https://semver.org/).
All notable changes are documented in [CHANGELOG.md](CHANGELOG.md).

## Code of Conduct

We as members, contributors, and leaders pledge to make participation in our community a harassment-free experience for everyone. By participating in this project, you agree to abide by its [Code of Conduct](CODE_OF_CONDUCT.md) at all times.

## Licensing

Copyright 2024 SAP SE or an SAP affiliate company and cds-dbs contributors. Please see our [LICENSE](LICENSE) for copyright and license information. Detailed information including third-party components and their licensing/copyright information is available [via the REUSE tool](https://api.reuse.software/info/github.com/cap-js/cds-dbs).
