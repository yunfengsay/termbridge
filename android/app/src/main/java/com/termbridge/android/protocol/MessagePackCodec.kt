package com.termbridge.android.protocol

import org.msgpack.core.MessagePack
import org.msgpack.core.MessagePacker
import org.msgpack.value.Value
import org.msgpack.value.ValueType
import java.io.ByteArrayOutputStream

object MessagePackCodec {
    fun packMap(values: Map<String, Any?>): ByteArray {
        val output = ByteArrayOutputStream()
        MessagePack.newDefaultPacker(output).use { packer ->
            packer.packMapHeader(values.size)
            values.forEach { (key, value) ->
                packer.packString(key)
                packer.packAny(value)
            }
        }
        return output.toByteArray()
    }

    fun unpackMap(bytes: ByteArray): Map<String, Any?> {
        val unpacker = MessagePack.newDefaultUnpacker(bytes)
        return unpacker.use {
            val value = it.unpackValue()
            require(value.isMapValue) { "control payload is not a map" }
            value.asMapValue().map().entries.associate { (key, child) ->
                require(key.isStringValue) { "control key is not a string" }
                key.asStringValue().asString() to child.toKotlinValue()
            }
        }
    }

    private fun MessagePacker.packAny(value: Any?) {
        when (value) {
            null -> packNil()
            is String -> packString(value)
            is Boolean -> packBoolean(value)
            is Byte -> packInt(value.toInt())
            is Short -> packInt(value.toInt())
            is Int -> packInt(value)
            is Long -> packLong(value)
            is Float -> packFloat(value)
            is Double -> packDouble(value)
            is ByteArray -> {
                packBinaryHeader(value.size)
                writePayload(value)
            }
            is List<*> -> {
                packArrayHeader(value.size)
                value.forEach { child -> this.packAny(child) }
            }
            is Map<*, *> -> {
                packMapHeader(value.size)
                value.forEach { (key, child) ->
                    require(key is String) { "MessagePack map keys must be strings" }
                    packString(key)
                    packAny(child)
                }
            }
            else -> error("Unsupported MessagePack value: ${value::class.java.name}")
        }
    }

    private fun Value.toKotlinValue(): Any? = when (valueType) {
        ValueType.NIL -> null
        ValueType.BOOLEAN -> asBooleanValue().boolean
        ValueType.INTEGER -> asIntegerValue().toLong()
        ValueType.FLOAT -> asFloatValue().toDouble()
        ValueType.STRING -> asStringValue().asString()
        ValueType.BINARY -> asBinaryValue().asByteArray()
        ValueType.ARRAY -> asArrayValue().list().map { it.toKotlinValue() }
        ValueType.MAP -> asMapValue().map().entries.associate { (key, child) ->
            require(key.isStringValue) { "MessagePack map key is not a string" }
            key.asStringValue().asString() to child.toKotlinValue()
        }
        ValueType.EXTENSION -> asExtensionValue().data
    }
}
