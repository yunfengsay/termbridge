package com.termbridge.android.peer

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

data class PhoneTodo(
    val id: String,
    val title: String,
    val notes: String? = null,
    val dueAt: String? = null,
    val completed: Boolean = false,
    val createdAt: Long,
    val updatedAt: Long,
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "id" to id,
        "title" to title,
        "notes" to notes,
        "dueAt" to dueAt,
        "completed" to completed,
        "createdAt" to createdAt,
        "updatedAt" to updatedAt,
    )

    fun toJson() = JSONObject(toMap())

    companion object {
        fun fromJson(json: JSONObject) = PhoneTodo(
            id = json.getString("id"),
            title = json.getString("title"),
            notes = json.stringOrNull("notes"),
            dueAt = json.stringOrNull("dueAt"),
            completed = json.optBoolean("completed"),
            createdAt = json.getLong("createdAt"),
            updatedAt = json.getLong("updatedAt"),
        )
    }
}

class PhoneTodoStore(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(STORE, Context.MODE_PRIVATE)

    @Synchronized
    fun execute(request: PhoneActionRequest): PhoneActionResult {
        val todos = read().toMutableList()
        val now = System.currentTimeMillis()
        return when (request.action) {
            "todo.list" -> PhoneActionResult(
                request.actionId,
                request.action,
                "completed",
                "已读取 ${todos.size} 条待办",
                mapOf("todos" to todos.sortedByDescending(PhoneTodo::updatedAt).take(50).map(PhoneTodo::toMap)),
            )
            "todo.create" -> {
                val todo = PhoneTodo(
                    id = UUID.randomUUID().toString(),
                    title = requireNotNull(request.title),
                    notes = request.notes,
                    dueAt = request.dueAt,
                    createdAt = now,
                    updatedAt = now,
                )
                todos += todo
                write(todos)
                PhoneActionResult(request.actionId, request.action, "completed", "已记录待办：${todo.title}", todo.toMap())
            }
            "todo.update" -> {
                val index = todos.indexOfFirst { it.id == request.todoId }
                require(index >= 0) { "待办不存在" }
                val current = todos[index]
                val updated = current.copy(
                    title = request.title ?: current.title,
                    notes = request.notes ?: current.notes,
                    dueAt = request.dueAt ?: current.dueAt,
                    updatedAt = now,
                )
                todos[index] = updated
                write(todos)
                PhoneActionResult(request.actionId, request.action, "completed", "已更新待办：${updated.title}", updated.toMap())
            }
            "todo.complete" -> {
                val index = todos.indexOfFirst { it.id == request.todoId }
                require(index >= 0) { "待办不存在" }
                val updated = todos[index].copy(completed = true, updatedAt = now)
                todos[index] = updated
                write(todos)
                PhoneActionResult(request.actionId, request.action, "completed", "已完成待办：${updated.title}", updated.toMap())
            }
            "todo.delete" -> {
                val removed = todos.firstOrNull { it.id == request.todoId } ?: error("待办不存在")
                todos.removeAll { it.id == request.todoId }
                write(todos)
                PhoneActionResult(request.actionId, request.action, "completed", "已删除待办：${removed.title}")
            }
            else -> error("unsupported to-do action")
        }
    }

    private fun read(): List<PhoneTodo> {
        val raw = preferences.getString(KEY, null) ?: return emptyList()
        return runCatching {
            val array = JSONArray(raw)
            (0 until array.length()).mapNotNull { index ->
                runCatching { PhoneTodo.fromJson(array.getJSONObject(index)) }.getOrNull()
            }
        }.getOrDefault(emptyList())
    }

    private fun write(todos: List<PhoneTodo>) {
        preferences.edit().putString(KEY, JSONArray(todos.map { it.toJson() }).toString()).apply()
    }

    private companion object {
        const val STORE = "phone_todos"
        const val KEY = "todos"
    }
}
