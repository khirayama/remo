import Foundation
import SQLite3

/// A minimal SQLite connection. Not thread-safe: each owner serializes access
/// on its own queue.
final class SQLiteConnection {
    struct Failure: Error, CustomStringConvertible {
        let description: String
    }

    private var handle: OpaquePointer?
    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    /// Opens (creating if needed) the database at [path], or an in-memory one for nil.
    init(path: String?) throws {
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(path ?? ":memory:", &handle, flags, nil) == SQLITE_OK else {
            let message = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "unknown error"
            sqlite3_close(handle)
            throw Failure(description: "Could not open database: \(message)")
        }
        try execute("PRAGMA journal_mode = WAL")
        try execute("PRAGMA synchronous = NORMAL")
    }

    deinit { sqlite3_close(handle) }

    func execute(_ sql: String) throws {
        var error: UnsafeMutablePointer<CChar>?
        guard sqlite3_exec(handle, sql, nil, nil, &error) == SQLITE_OK else {
            let message = error.map { String(cString: $0) } ?? "unknown error"
            sqlite3_free(error)
            throw Failure(description: message)
        }
    }

    /// Runs [sql] once per element of [rows], binding each row's values in order.
    func run(_ sql: String, _ rows: [[SQLiteValue]]) throws {
        let statement = try prepare(sql)
        defer { sqlite3_finalize(statement) }
        for values in rows {
            try bind(values, to: statement)
            guard sqlite3_step(statement) == SQLITE_DONE else { throw lastError() }
            sqlite3_reset(statement)
            sqlite3_clear_bindings(statement)
        }
    }

    func run(_ sql: String, _ values: [SQLiteValue] = []) throws { try run(sql, [values]) }

    func query<T>(_ sql: String, _ values: [SQLiteValue] = [], row: (SQLiteRow) -> T?) throws -> [T] {
        let statement = try prepare(sql)
        defer { sqlite3_finalize(statement) }
        try bind(values, to: statement)
        var results: [T] = []
        while true {
            let step = sqlite3_step(statement)
            if step == SQLITE_DONE { break }
            guard step == SQLITE_ROW else { throw lastError() }
            if let value = row(SQLiteRow(statement: statement)) { results.append(value) }
        }
        return results
    }

    func transaction(_ work: () throws -> Void) throws {
        try execute("BEGIN IMMEDIATE")
        do {
            try work()
            try execute("COMMIT")
        } catch {
            try? execute("ROLLBACK")
            throw error
        }
    }

    private func prepare(_ sql: String) throws -> OpaquePointer? {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK else { throw lastError() }
        return statement
    }

    private func bind(_ values: [SQLiteValue], to statement: OpaquePointer?) throws {
        for (offset, value) in values.enumerated() {
            let index = Int32(offset + 1)
            let result: Int32
            switch value {
            case .null: result = sqlite3_bind_null(statement, index)
            case let .integer(number): result = sqlite3_bind_int64(statement, index, number)
            case let .real(number): result = sqlite3_bind_double(statement, index, number)
            case let .text(text): result = sqlite3_bind_text(statement, index, text, -1, Self.transient)
            }
            guard result == SQLITE_OK else { throw lastError() }
        }
    }

    private func lastError() -> Failure { Failure(description: String(cString: sqlite3_errmsg(handle))) }
}

enum SQLiteValue {
    case null
    case integer(Int64)
    case real(Double)
    case text(String)

    static func optional(_ value: Double?) -> SQLiteValue { value.map(SQLiteValue.real) ?? .null }
    static func optional(_ value: String?) -> SQLiteValue { value.map(SQLiteValue.text) ?? .null }
}

struct SQLiteRow {
    fileprivate let statement: OpaquePointer?

    func isNull(_ column: Int32) -> Bool { sqlite3_column_type(statement, column) == SQLITE_NULL }
    func double(_ column: Int32) -> Double? { isNull(column) ? nil : sqlite3_column_double(statement, column) }
    func integer(_ column: Int32) -> Int64? { isNull(column) ? nil : sqlite3_column_int64(statement, column) }
    func text(_ column: Int32) -> String? {
        guard !isNull(column), let pointer = sqlite3_column_text(statement, column) else { return nil }
        return String(cString: pointer)
    }
}

extension FileManager {
    /// Application Support, created if needed.
    func remoSupportDirectory() -> URL {
        let directory = urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? urls(for: .documentDirectory, in: .userDomainMask)[0]
        try? createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }
}
