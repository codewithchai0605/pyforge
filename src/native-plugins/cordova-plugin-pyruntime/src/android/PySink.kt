package com.pyforge.pyruntime

/**
 * What Python calls to push one JSON event line out to Kotlin.
 *
 * Deliberately a plain, public, named class rather than a lambda or an
 * `object : ...` expression: Chaquopy reaches Java/Kotlin objects by
 * reflection, and a public method on an anonymous (non-public) class can
 * fail with IllegalAccessException when invoked from Python.
 */
class PySink(private val callback: (String) -> Unit) {
    fun emit(line: String) {
        callback(line)
    }
}
