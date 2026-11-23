package com.termbridge.android.network

import java.net.InetSocketAddress
import java.net.Socket
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.X509TrustManager

object LanConnection {
    fun isUnicastIPv4(address: String): Boolean {
        val pieces = address.split('.')
        if (pieces.size != 4 || pieces.any { it.isEmpty() || (it.length > 1 && it.startsWith('0')) || it.any { c -> c !in '0'..'9' } }) return false
        val n = pieces.map { it.toIntOrNull() ?: return false }
        if (n.any { it !in 0..255 }) return false
        return n[0] in 1..223
    }
    fun isPrivateIPv4(address: String): Boolean {
        if (!isUnicastIPv4(address)) return false
        val n = address.split('.').map(String::toInt)
        return n[0] == 10 || n[0] == 127 || (n[0] == 192 && n[1] == 168) ||
            (n[0] == 172 && n[1] in 16..31) || (n[0] == 169 && n[1] == 254)
    }
    fun url(address: String, port: String, useTls: Boolean = false): String {
        val ip = address.trim()
        require(isUnicastIPv4(ip)) { "请输入 Mac 的内网 IPv4 地址" }
        val number = port.toIntOrNull()
        require(number != null && number in 1024..65535) { "端口须为 1024–65535" }
        return "${if (useTls) "wss" else "ws"}://$ip:$number"
    }
    /** Discovery only: a TLS handshake, no password or application data. User confirms before pinning. */
    fun probe(address: String, port: Int): String {
        require(isUnicastIPv4(address) && port in 1024..65535)
        Socket().use { socket ->
            socket.connect(InetSocketAddress(address, port), 5000); socket.soTimeout = 5000
            handshake(socket, address, port).use { tls ->
                return MessageDigest.getInstance("SHA-256").digest(tls.session.peerCertificates[0].encoded)
                    .joinToString("") { "%02x".format(it) }
            }
        }
    }

    /** A TLS handshake over a connected socket that accepts any currently valid certificate: discovery and reachability only. */
    @android.annotation.SuppressLint("CustomX509TrustManager", "TrustAllX509TrustManager")
    fun handshake(socket: Socket, host: String, port: Int): SSLSocket {
        val trust = object : X509TrustManager {
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
                require(!chain.isNullOrEmpty()); chain[0].checkValidity()
            }
        }
        val context = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), SecureRandom()) }
        return (context.socketFactory.createSocket(socket, host, port, true) as SSLSocket).apply {
            soTimeout = socket.soTimeout; startHandshake()
        }
    }
}
