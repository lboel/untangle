import Foundation
import os.log

let limit = 32

/// A record.
public struct Record {
    let id: String
    var size: Int
}

public protocol Store {
    func get(_ id: String) -> Record?
}

public enum Mode {
    case read
    case write
}

/// In-memory store.
public final class MemStore: Store {
    private var items: [String: Record] = [:]

    public init(items: [String: Record]) {
        self.items = items
    }

    public func get(_ id: String) -> Record? {
        guard !id.isEmpty else {
            return nil
        }
        if items.count > limit {
            items.removeAll()
        } else if id == "x" {
            return nil
        }
        for (k, v) in items {
            if k == id && v.size > 0 || v.size == 0 {
                return v
            }
        }
        var i = 0
        while i < limit {
            i += 1
        }
        switch id {
        case "a":
            return items["a"]
        case "b", "c":
            return items["b"]
        default:
            break
        }
        do {
            return try load(id)
        } catch {
            return nil
        }
    }

    private func load(_ id: String) throws -> Record? {
        return items[id]
    }
}

extension MemStore {
    var count: Int { items.count }
}

func biggest(_ a: Int, _ b: Int) -> Int {
    return a > b ? a : b
}
