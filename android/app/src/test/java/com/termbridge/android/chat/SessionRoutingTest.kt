package com.termbridge.android.chat

import com.termbridge.android.data.ConnectionSettings
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A session window belongs to one Host and to whichever view the user last
 * chose for it. Both survive the app's current profile changing underneath.
 */
class SessionRoutingTest {
    private fun profile(host: String, relay: String = "ws://relay.invalid/a") =
        ConnectionSettings(relayUrl = relay, hostId = host, secret = "s", tlsFingerprint = "")

    @Test fun sameMacKeepsItsPinnedLanEndpointInsteadOfTheFirstPublicProfile() {
        val public = profile("same-mac", "wss://public.example")
        val lan = profile("same-mac", "wss://192.168.1.2:7400")
        val pin = SessionHostPin.pin("same-mac", lan, listOf(public, lan))
        assertEquals(lan.endpointKey, pin?.endpointKey)
        assertEquals(lan, SessionHostPin.resolve(pin, public, listOf(public, lan)))
        assertNull(SessionHostPin.resolve(pin, public, listOf(public)))
        assertNull(SessionHostPin.resolve(pin, lan.copy(hostId = "different-mac"), listOf(public)))
    }

    @Test fun aWindowPinsTheHostItWasOpenedAgainst() {
        val current = profile("host-a")
        assertEquals("host-a", SessionHostPin.pin(null, current)?.hostId)
        assertEquals("host-b", SessionHostPin.pin("host-b", current)?.hostId)
        assertEquals("host-b", SessionHostPin.pin("  host-b  ", current)?.hostId)
        assertNull(SessionHostPin.pin("  ", null))
    }

    @Test fun switchingTheCurrentProfileDoesNotMoveAPinnedSession() {
        val a = profile("host-a")
        val b = profile("host-b", relay = "ws://relay.invalid/b")
        val pin = SessionHostPin.pin("host-a", b, listOf(b, a))
        // The user moved the app to Host B while this window stays on Host A.
        val resolved = SessionHostPin.resolve(pin, b, listOf(b, a))
        assertEquals("host-a", resolved?.hostId)
        assertEquals(a.relayUrl, resolved?.relayUrl)
        // With no pin the window follows whatever is current, as before.
        assertEquals("host-b", SessionHostPin.resolve(null, b, listOf(b, a))?.hostId)
    }

    @Test fun aRemovedProfileStopsTheWindowInsteadOfAttachingElsewhere() {
        val a = profile("host-a")
        val b = profile("host-b", relay = "ws://relay.invalid/b")
        val pin = SessionHostPin.pin("host-a", a, listOf(a, b))
        assertNull(SessionHostPin.resolve(pin, b, listOf(b)))
        assertNull(SessionHostPin.resolve(pin, null, emptyList()))
        // A profile that is current but not yet listed still counts as present.
        assertEquals("host-a", SessionHostPin.resolve(pin, a, emptyList())?.hostId)
    }

    /**
     * A profile that has not negotiated its Host yet still identifies this
     * window. Without that, the pin was null and every resolve fell through to
     * whichever profile happened to be current.
     */
    @Test fun aProfileWithNoDiscoveredHostIsStillPinned() {
        val pending = ConnectionSettings(relayUrl = "ws://relay.invalid/a", hostId = "", secret = "s", tlsFingerprint = "")
        val other = profile("host-b", relay = "ws://relay.invalid/b")
        val pin = SessionHostPin.pin(null, pending, listOf(pending, other))
        assertNotNull(pin)
        assertEquals("", pin?.hostId)

        // Terminal/Chat switch away, then the app moves to Host B: this window stays put.
        assertEquals(pending.endpointKey, SessionHostPin.resolve(pin, other, listOf(pending, other))?.endpointKey)
        assertEquals("host-b", SessionHostPin.resolve(null, other, listOf(pending, other))?.hostId)

        // Discovery only fills in the Host, so the same profile is still recognised,
        // and the pin is then strengthened to that Host.
        val discovered = pending.copy(hostId = "host-a")
        val resolved = SessionHostPin.resolve(pin, other, listOf(discovered, other))
        assertEquals("host-a", resolved?.hostId)
        assertEquals("host-a", SessionHostPin.negotiated(pin, resolved!!)?.hostId)

        // Removing that saved profile stops the window instead of falling back to B.
        assertNull(SessionHostPin.resolve(pin, other, listOf(other)))
    }

    /**
     * The navigation decision itself, as the Activity calls it: a notification
     * for a deleted Host must not rebuild that profile from the current one's
     * relay and credentials.
     */
    @Test fun notificationNavigationNeverSynthesizesAProfile() {
        val b = profile("host-b", relay = "ws://relay.invalid/b")
        val deleted = SessionHostPin.pin("host-a", b, listOf(b))
        val stopped = SessionHostPin.navigate(deleted, b, listOf(b))
        assertNull("navigation must not invent a profile for a deleted Host", stopped.profile)
        assertNull(stopped.selectProfileKey)

        // A saved Host is selected, and the profile handed back is that saved one.
        val a = profile("host-a")
        val pin = SessionHostPin.pin("host-a", b, listOf(a, b))
        val moved = SessionHostPin.navigate(pin, b, listOf(a, b))
        assertSame(a, moved.profile)
        assertEquals(a.profileKey, moved.selectProfileKey)
        assertEquals(a.relayUrl, moved.profile?.relayUrl)

        // Already on that profile: nothing to switch.
        assertNull(SessionHostPin.navigate(pin, a, listOf(a, b)).selectProfileKey)
    }

    @Test fun aRestoredPinSurvivesRotationWithoutRePinning() {
        val pending = ConnectionSettings(relayUrl = "ws://relay.invalid/a", hostId = "", secret = "s", tlsFingerprint = "")
        val other = profile("host-b", relay = "ws://relay.invalid/b")
        val pin = SessionHostPin.pin(null, pending, listOf(pending, other))
        val restored = SessionHostPin.restore(pin?.hostId, pin?.endpointKey)
        assertEquals(pin, restored)
        assertEquals(pending.endpointKey, SessionHostPin.resolve(restored, other, listOf(pending, other))?.endpointKey)
        assertNull(SessionHostPin.restore(null, null))
        assertNull(SessionHostPin.restore("", ""))
    }

    /**
     * Review used to return from its routing helper and then connect anyway,
     * through whatever profile was current, sending the original Host's session
     * ID to it. The gate owns client creation, so a deleted Host means nothing
     * is constructed at all.
     */
    @Test fun aDeletedHostCreatesNoClientAndNoOperationForTheCurrentOne() {
        val a = profile("host-a")
        val b = profile("host-b", relay = "ws://relay.invalid/b")
        val opened = mutableListOf<ConnectionSettings>()
        val closed = mutableListOf<ConnectionSettings>()
        val gate = SessionConnectionGate<ConnectionSettings>(
            openClient = { it.also(opened::add) },
            closeClient = { closed.add(it) },
        )
        gate.pin = SessionHostPin.pin("host-a", a, listOf(a, b))

        // Host A is still saved: one client, on A's own relay.
        assertNotNull(gate.connect(a, listOf(a, b)))
        assertEquals(1, opened.size)
        assertEquals(a.relayUrl, opened.single().relayUrl)
        val live = gate.generation
        assertTrue(gate.accepts(live))

        // The user deletes Host A and the app falls back to Host B.
        assertNull("a deleted Host must not open a connection", gate.connect(b, listOf(b)))
        assertEquals("no client may be constructed for another Host", 1, opened.size)
        assertNull(gate.client)
        assertEquals(listOf(a.relayUrl), closed.map { it.relayUrl })

        // The previous client's callbacks can no longer drive this screen, so a
        // snapshot request or branch action cannot ride the old connection.
        assertFalse("a replaced client must not deliver late callbacks", gate.accepts(live))
        assertFalse(gate.accepts(gate.generation))
    }

    /**
     * The cross-view handoff for a profile that has no Host ID yet: switching
     * Chat -> Terminal while the app has moved to another Host must carry the
     * whole pin, not just the (empty) Host ID.
     */
    @Test fun anEmptyHostIdPinSurvivesTheCrossViewHandoff() {
        val pending = ConnectionSettings(relayUrl = "ws://relay.invalid/a", hostId = "", secret = "s", tlsFingerprint = "")
        val b = profile("host-b", relay = "ws://relay.invalid/b")
        val profiles = listOf(pending, b)
        val chatPin = SessionHostPin.pin(null, pending, profiles)
        assertEquals("", chatPin?.hostId)

        // Chat hands the window to Terminal while the app is on Host B.
        val (hostExtra, endpointExtra) = SessionPinHandoff.extras(chatPin)
        assertEquals(pending.endpointKey, endpointExtra)
        val received = SessionPinHandoff.receive(
            forwarded = endpointExtra != null,
            hostId = hostExtra,
            endpointKey = endpointExtra,
            current = b,
            profiles = profiles,
        )
        assertEquals(chatPin, received)
        assertEquals(pending.endpointKey, SessionHostPin.resolve(received, b, profiles)?.endpointKey)

        // Without the handoff the receiving screen derives a pin from Host B —
        // the defect this guards.
        val derived = SessionPinHandoff.receive(false, null, null, b, profiles)
        assertEquals("host-b", SessionHostPin.resolve(derived, b, profiles)?.hostId)

        // A forwarded but unusable pin fails closed instead of adopting Host B.
        val broken = SessionPinHandoff.receive(true, "", "", b, profiles)
        assertNull(SessionHostPin.resolve(broken, b, profiles))

        // Terminal -> Chat carries it back unchanged, and so does a rotation.
        val (backHost, backEndpoint) = SessionPinHandoff.extras(received)
        assertEquals(chatPin, SessionPinHandoff.receive(backEndpoint != null, backHost, backEndpoint, b, profiles))
        assertEquals(chatPin, SessionHostPin.restore(backHost, backEndpoint))
    }

    @Test fun defaultViewAppliesUntilTheSessionHasItsOwnChoice() {
        assertTrue(SessionUiRouting.startsInChat(SessionUi.AUTO, null, isHerdr = true))
        assertFalse(SessionUiRouting.startsInChat(SessionUi.AUTO, null, isHerdr = false))
        assertTrue(SessionUiRouting.startsInChat(SessionUi.CHAT, null, isHerdr = false))
        assertFalse(SessionUiRouting.startsInChat(SessionUi.TERMINAL, null, isHerdr = true))
        // A manual switch wins over the device default, either way.
        assertFalse(SessionUiRouting.startsInChat(SessionUi.CHAT, SessionUi.TERMINAL, isHerdr = true))
        assertTrue(SessionUiRouting.startsInChat(SessionUi.TERMINAL, SessionUi.CHAT, isHerdr = false))
    }

    @Test fun changingTheDefaultReachesSessionsWithoutTheirOwnChoice() {
        // The notification for "s1" was created while the default was Terminal.
        var stored = SessionUiRouting.with(null, "s1", SessionUi.TERMINAL)
        assertEquals(SessionUi.TERMINAL, SessionUiRouting.of(stored, "s1"))
        // Clearing the session's choice lets the new default apply again.
        stored = SessionUiRouting.with(stored, "s1", SessionUi.AUTO)
        assertNull(SessionUiRouting.of(stored, "s1"))
        assertTrue(SessionUiRouting.startsInChat(SessionUi.CHAT, SessionUiRouting.of(stored, "s1"), isHerdr = false))
    }

    @Test fun overridesAreBoundedAndRejectCorruptKeys() {
        var stored: String? = null
        for (index in 0 until SessionUiRouting.MAX_OVERRIDES + 5) {
            stored = SessionUiRouting.with(stored, "session-" + index, SessionUi.CHAT)
        }
        val decoded = SessionUiRouting.decode(stored)
        assertEquals(SessionUiRouting.MAX_OVERRIDES, decoded.size)
        assertNull(decoded["session-0"])
        assertEquals(SessionUi.CHAT, decoded["session-" + (SessionUiRouting.MAX_OVERRIDES + 4)])
        // Re-choosing keeps a session alive rather than aging it out.
        val refreshed = SessionUiRouting.with(stored, "session-6", SessionUi.TERMINAL)
        assertEquals(SessionUi.TERMINAL, SessionUiRouting.of(refreshed, "session-6"))
        // A key that could forge a second entry is refused, not stored.
        assertEquals(stored, SessionUiRouting.with(stored, "a\u0000b", SessionUi.CHAT))
        assertEquals(stored, SessionUiRouting.with(stored, "a\nb", SessionUi.CHAT))
        assertEquals(stored, SessionUiRouting.with(stored, "", SessionUi.CHAT))
        assertTrue(SessionUiRouting.decode("garbage-without-separator").isEmpty())
        assertTrue(SessionUiRouting.decode(null).isEmpty())
    }

    @Test fun aReloadedSurfaceResubscribesRatherThanReplayingAStaleSnapshot() {
        val gate = AgentChatSurfaceGate()
        assertFalse(gate.ready)
        assertEquals(
            "the first page replays what arrived while it was loading",
            SurfaceReadyAction.REPLAY,
            gate.becameReady(connected = true, subscribed = true),
        )
        assertTrue(gate.ready)
        // The page went away; the shell must stop treating it as holding the chat.
        assertTrue(gate.reset())
        assertFalse(gate.ready)
        assertFalse("a surface that is already gone is not lost twice", gate.reset())
        assertEquals(
            "a reloaded page needs a fresh snapshot",
            SurfaceReadyAction.SUBSCRIBE,
            gate.becameReady(connected = true, subscribed = false),
        )
        assertTrue(gate.ready)
    }

    /**
     * The renderer can die before the first page ever draws. The replacement
     * page then has no subscription to replay from, so replaying its empty cache
     * would leave the view blank for good.
     */
    @Test fun aRendererThatDiesBeforeItsFirstFrameStillSubscribes() {
        val gate = AgentChatSurfaceGate()
        val epoch = AgentChatEpoch()
        val draft = AgentChatDraft()
        val connection = epoch.nextConnection()
        val first = epoch.nextSubscription()
        draft.text = "请检查这个改动"
        draft.begin("send-1", first)

        // The renderer dies before that page reached ready; the subscription goes with it.
        assertFalse("a page that never drew was not holding anything", gate.reset())
        val dropped = epoch.nextSubscription()
        draft.disconnected("unconfirmed")

        assertEquals(
            SurfaceReadyAction.SUBSCRIBE,
            gate.becameReady(connected = true, subscribed = false),
        )
        val fresh = epoch.nextSubscription()

        // Anything produced for either superseded subscription is rejected.
        assertFalse(epoch.accepts(connection, "s", "s", first))
        assertFalse(epoch.accepts(connection, "s", "s", dropped))
        assertTrue(epoch.accepts(connection, "s", "s", fresh))

        // The send that was in flight stays unconfirmed: not pending, and not
        // offered for retry, so nothing resends it behind the user.
        assertEquals("uncertain", draft.state)
        assertFalse(draft.pending)
        assertFalse(draft.retryable)
        assertEquals("请检查这个改动", draft.submittedText())
        // A delivery produced for the dropped subscription is filtered by the
        // epoch before it can reach the composer at all.
        assertFalse(epoch.accepts(connection, "s", "s", dropped))
        // Only a receipt that survives that check may resolve the uncertainty,
        // and it confirms the original send rather than repeating it.
        assertTrue(draft.receipt("send-1", first, "observed", null))
        assertEquals("observed", draft.state)
        assertFalse(draft.pending)
    }

    @Test fun aReadyPageWaitsWhenTheConnectionIsNotUpYet() {
        val gate = AgentChatSurfaceGate()
        assertEquals(SurfaceReadyAction.WAIT, gate.becameReady(connected = false, subscribed = false))
        assertTrue(gate.ready)
        // The connection comes up and subscribes; a later reload still refreshes.
        assertEquals(SurfaceReadyAction.SUBSCRIBE, gate.becameReady(connected = true, subscribed = true))
    }
}
