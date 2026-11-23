package com.termbridge.android.chat

/**
 * When a queued image may actually leave for the Host.
 *
 * Sending `agent_chat_subscribe` is a request, not a grant. The Host is still
 * awaiting describe/locate at that point and will refuse an upload aimed at a
 * conversation it has not bound yet — and a refusal is acknowledged, which
 * removes the image from the queue. So an encode that finishes inside that
 * window would silently cost the user their picture.
 *
 * The grant is the snapshot the Host sends for the generation we asked for.
 * Only that opens the gate, and anything that ends the subscription closes it
 * again, so the next generation has to earn it for itself.
 */
class SessionUploadGate {
    /** The generation the Host has actually answered, or -1 for none. */
    var confirmedGeneration = -1
        private set

    /** A new subscription is in flight; nothing is granted until it answers. */
    fun requested() {
        confirmedGeneration = -1
    }

    /** The Host answered for this generation: uploads for it are authorized. */
    fun confirmed(generation: Int) {
        confirmedGeneration = generation
    }

    /** Disconnect, loss, degradation or a lost surface all revoke the grant. */
    fun revoked() {
        confirmedGeneration = -1
    }

    /**
     * @param generation the view's current subscription generation
     *
     * A grant earned by an earlier generation does not carry over: that
     * subscription is gone, and the Host tracks the new one separately.
     */
    fun allows(generation: Int): Boolean =
        confirmedGeneration >= 0 && confirmedGeneration == generation
}
