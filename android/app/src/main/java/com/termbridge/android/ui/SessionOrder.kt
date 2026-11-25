package com.termbridge.android.ui

import com.termbridge.android.protocol.SessionInfo

/**
 * Deterministic, fixed ordering for the session list.
 *
 * Never sorts by transient state (`viewers`/`isActive`, `status`, `completedAt`, `preview`, or
 * mutable terminal title), so tapping a session or receiving background status updates never
 * causes rows to jump around.
 */
object SessionOrder {
    fun sort(sessions: List<SessionInfo>): List<SessionInfo> =
        sessions.sortedWith(
            compareBy<SessionInfo> { it.workspace.isNullOrBlank() }
                .thenComparator { a, b -> naturalCompare(a.workspace.orEmpty().trim(), b.workspace.orEmpty().trim()) }
                .thenBy { if (it.isHerdr) 0 else 1 }
                .thenBy { if (it.workspace.isNullOrBlank()) it.createdAt else 0L }
                .thenComparator { a, b -> naturalCompare(a.sessionId, b.sessionId) },
        )

    internal fun naturalCompare(a: String, b: String): Int {
        var i = 0
        var j = 0
        while (i < a.length && j < b.length) {
            val ca = a[i]
            val cb = b[j]
            if (ca.isDigit() && cb.isDigit()) {
                var endA = i
                while (endA < a.length && a[endA].isDigit()) endA++
                var endB = j
                while (endB < b.length && b[endB].isDigit()) endB++
                val numA = a.substring(i, endA).trimStart('0')
                val numB = b.substring(j, endB).trimStart('0')
                if (numA.length != numB.length) return numA.length.compareTo(numB.length)
                val cmp = numA.compareTo(numB)
                if (cmp != 0) return cmp
                if ((endA - i) != (endB - j)) return (endA - i).compareTo(endB - j)
                i = endA
                j = endB
            } else {
                val la = ca.lowercaseChar()
                val lb = cb.lowercaseChar()
                if (la != lb) return la.compareTo(lb)
                i++
                j++
            }
        }
        return (a.length - i).compareTo(b.length - j)
    }
}
