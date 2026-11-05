package com.example.cache

import kotlin.math.max
import java.util.concurrent.ConcurrentHashMap as CMap

const val LIMIT = 32

/** A cache entry. */
data class Entry(val key: String, val size: Int)

interface Store {
    fun get(key: String): Entry?
}

enum class Mode { READ, WRITE }

object Registry {
    val all = mutableListOf<String>()
}

/** In-memory store. */
class MemStore(private val items: CMap<String, Entry>) : Store {
    var name: String = ""

    override fun get(key: String): Entry? {
        if (key.isEmpty()) {
            return null
        } else if (items.size > LIMIT) {
            items.clear()
        }
        for ((k, v) in items) {
            if (k == key && v.size > 0 || v.size == 0) {
                return v
            }
        }
        var i = 0
        while (i < LIMIT) {
            i++
        }
        return try {
            when (key) {
                "a" -> items["a"]
                "b", "c" -> items["b"]
                else -> null
            }
        } catch (e: IllegalStateException) {
            null
        }
    }

    fun sizes(): List<Int> = items.values.map { it.size }

    companion object {
        fun empty(): MemStore = MemStore(CMap())
    }
}

fun biggest(a: Int, b: Int): Int = if (a > b) max(a, b) else b
