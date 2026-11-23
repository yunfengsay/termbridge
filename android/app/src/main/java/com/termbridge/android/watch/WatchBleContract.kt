package com.termbridge.android.watch

import java.util.UUID

object WatchBleContract {
    val SERVICE_UUID: UUID = UUID.fromString("7f510001-5a7d-4b79-9c2e-7b4e54420001")
    val WATCH_TO_PHONE_UUID: UUID = UUID.fromString("7f510002-5a7d-4b79-9c2e-7b4e54420002")
    val PHONE_TO_WATCH_UUID: UUID = UUID.fromString("7f510003-5a7d-4b79-9c2e-7b4e54420003")
    val CLIENT_CONFIGURATION_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    const val ADVERTISED_NAME = "TermBridge Watch"
    const val PREFERRED_MTU = 517
}
