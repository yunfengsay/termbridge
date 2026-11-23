package com.termbridge.android.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import com.termbridge.android.protocol.HostNetworkPolicy

class ConnectionProfilesTest {
    private val homePair = ConnectionSettings("wss://relay.example/r/home", "", "home-secret", "")
    private val officePair = ConnectionSettings("wss://relay.example/r/office", "", "office-secret", "")

    @Test
    fun scanningAnotherPairAddsAProfileInsteadOfReplacingTheFirst() {
        val home = ConnectionProfiles.upsert(ConnectionProfileState(emptyList(), null), homePair)
        val office = ConnectionProfiles.upsert(home, officePair)

        assertEquals(2, office.profiles.size)
        assertEquals(officePair.profileKey, office.activeKey)
        assertTrue(office.profiles.any { it.secret == "home-secret" })
        assertTrue(office.profiles.any { it.secret == "office-secret" })
    }

    @Test
    fun networkPolicyIsScopedToOneHostAndSurvivesRosterRefresh() {
        val home = ConnectionProfiles.upsert(
            ConnectionProfileState(emptyList(), null),
            homePair.copy(hostId = "mac-home"),
        )
        val both = ConnectionProfiles.upsert(home, officePair.copy(hostId = "mac-office"))
        val directHome = ConnectionProfiles.setNetworkPolicy(
            both,
            homePair.copy(hostId = "mac-home").profileKey,
            HostNetworkPolicy.DIRECT,
        )
        val refreshed = ConnectionProfiles.mergeDiscoveredHosts(
            directHome,
            directHome.profiles.first { it.hostId == "mac-home" },
            listOf("mac-home" to "Home", "mac-office" to "Office"),
            "mac-home",
        )

        assertEquals(HostNetworkPolicy.DIRECT, refreshed.profiles.first { it.hostId == "mac-home" }.networkPolicy)
        assertEquals(HostNetworkPolicy.SYSTEM, refreshed.profiles.first { it.hostId == "mac-office" }.networkPolicy)
    }

    @Test
    fun discoveredMacIdsBecomeDeduplicatedNamedTabs() {
        val paired = ConnectionProfiles.upsert(ConnectionProfileState(emptyList(), null), homePair)
        val discovered = ConnectionProfiles.mergeDiscoveredHosts(
            paired,
            homePair,
            listOf("mac-home" to "Home Mac mini", "mac-office" to "Office Mac mini"),
            "mac-home",
        )
        val rescanned = ConnectionProfiles.upsert(
            discovered,
            homePair.copy(hostId = "mac-home", hostName = "Renamed Home"),
        )

        assertEquals(2, rescanned.profiles.size)
        assertEquals(homePair.copy(hostId = "mac-home").profileKey, rescanned.activeKey)
        assertEquals("Renamed Home", rescanned.profiles.first { it.hostId == "mac-home" }.displayName)
        assertFalse(rescanned.profiles.any { it.hostId.isBlank() })
    }

    @Test
    fun profileKeysHidePairingSecretsAndRemovingTheActiveTabSelectsAnother() {
        assertNotEquals(homePair.secret, homePair.profileKey)
        val home = ConnectionProfiles.upsert(ConnectionProfileState(emptyList(), null), homePair.copy(hostId = "mac-home"))
        val office = ConnectionProfiles.upsert(home, officePair.copy(hostId = "mac-office"))
        val removed = ConnectionProfiles.remove(office, office.activeKey!!)

        assertEquals(listOf("mac-home"), removed.profiles.map(ConnectionSettings::hostId))
        assertEquals(homePair.copy(hostId = "mac-home").profileKey, removed.activeKey)
    }

    @Test
    fun disconnectingAProfileKeepsItSavedUntilExplicitReconnect() {
        val paired = ConnectionProfiles.upsert(
            ConnectionProfileState(emptyList(), null),
            homePair.copy(hostId = "mac-home", hostName = "Home Mac"),
        )

        val disconnected = ConnectionProfiles.setConnectionEnabled(paired, homePair.copy(hostId = "mac-home").profileKey, false)
        assertEquals(homePair.copy(hostId = "mac-home").profileKey, disconnected.activeKey)
        assertEquals(1, disconnected.profiles.size)
        assertFalse(disconnected.profiles.single().connectionEnabled)
        assertEquals("home-secret", disconnected.profiles.single().secret)

        val reconnected = ConnectionProfiles.setConnectionEnabled(disconnected, homePair.copy(hostId = "mac-home").profileKey, true)
        assertTrue(reconnected.profiles.single().connectionEnabled)
    }

    @Test
    fun localAliasSurvivesHostDiscoveryAndCanBeResetToTheReportedName() {
        val discovered = ConnectionProfiles.mergeDiscoveredHosts(
            ConnectionProfileState(emptyList(), null),
            homePair,
            listOf("mac-home" to "U-VGDG2WNW-580.local"),
            "mac-home",
        )
        val renamed = ConnectionProfiles.rename(discovered, homePair.copy(hostId = "mac-home").profileKey, "  公司 Mac mini  ")
        val refreshed = ConnectionProfiles.mergeDiscoveredHosts(
            renamed,
            homePair,
            listOf("mac-home" to "new-random-name.local"),
            "mac-home",
        )

        assertEquals("公司 Mac mini", refreshed.profiles.single().displayName)
        assertEquals("new-random-name.local", refreshed.profiles.single().hostName)

        val reset = ConnectionProfiles.rename(refreshed, homePair.copy(hostId = "mac-home").profileKey, "   ")
        assertEquals("new-random-name.local", reset.profiles.single().displayName)
    }

    @Test fun sameMacOnLanAndRemoteServerRemainSeparate() {
        val remote = homePair.copy(hostId = "mac-one", profileAlias = "Remote")
        val lan = remote.copy(relayUrl = "wss://192.168.1.10:7400", profileAlias = "LAN")
        val state = ConnectionProfiles.upsert(ConnectionProfiles.upsert(ConnectionProfileState(emptyList(), null), remote), lan)
        assertEquals(2, state.profiles.size)
        assertNotEquals(remote.profileKey, lan.profileKey)
        assertEquals(lan.profileKey, state.activeKey)
        assertEquals(remote.profileKey, ConnectionProfiles.migratedActiveKey(state.profiles, "host:mac-one"))
        val changed = lan.copy(relayUrl = "wss://192.168.1.11:7400")
        val updated = ConnectionProfiles.replace(state, lan.profileKey, changed)
        assertEquals(listOf(remote, changed), updated.profiles)
        assertEquals(changed.profileKey, updated.activeKey)
    }
}
