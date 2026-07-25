# Feature 04: Call & Messaging Capabilities

## Overview

Call & Messaging lets users reach out to customers directly from within the CRM without switching to their phone dialer or messaging app. The critical insight is that every time a salesperson leaves the CRM to make a call or send a message, there is a 70% chance they won't log it afterward. By keeping communication inside the app, everything is captured automatically.

One-tap calling uses the device's native phone dialer — the CRM does not attempt to replace telephony infrastructure for MVP. After the call ends, the app prompts the user to add call notes and automatically logs the call duration and timestamp. Messaging is handled in-app, for internal coordination and for customer portal communication, so every thread stays attached to the contact it belongs to.

Notifications ensure the user knows immediately when a customer replies, removing the need to poll the app.

## User Stories

- **As a sales rep**, I want to tap a contact's phone number and immediately start a call so that I don't have to manually dial or switch between apps.
- **As a sales rep**, I want the app to prompt me to add call notes immediately after I hang up so that I capture context while it's fresh.
- **As a customer success manager**, I want to message a client directly from their contact profile so that I don't have to switch to another app and lose track of the conversation.
- **As a sales rep**, I want to receive a push notification when a customer replies to my message so that I can respond quickly.
- **As a manager**, I want to see all calls and messages a rep had with a contact this week so that I can review the relationship before a handoff.
- **As a team member**, I want to send a message to a contact and have it automatically logged in their activity history so that I don't have to enter it manually.

## Acceptance Criteria

- One-tap call: `tel://` deep link opens native phone dialer; call is pre-initiated with contact's phone number
- Post-call prompt: when user returns to app after a call (foreground detection), prompt "Add notes for this call?" with duration auto-estimated from elapsed time
- Call notes: free text; automatically logged to activity_log with type=call, contact_id, user_id, timestamp, duration
- In-app messaging: sends message record to backend; real-time delivery via WebSocket if contact has app
- Inbound message: stored in messages table → real-time push notification to assigned rep
- Message thread view: chronological conversation with contact, sent and received messages in one thread
- Unread indicator: badge on contact list item and Messages tab for unread inbound messages
- All sent/received messages automatically logged to activity_log with type=message

## Edge Cases

- User makes a call but hangs up in under 5 seconds: still show note prompt, but label it as "Missed call / Short call" with option to log it as a missed call
- Contact has no phone number: disable "Call" button; show tooltip "Add a phone number to enable calling"
- Message send fails while the device is offline: message is queued locally and retried on reconnect; idempotent on retry (client-generated message id prevents duplicates in the thread)
- Two reps messaging the same contact simultaneously: both messages are sent; conversation thread shows both with sender name
- International phone numbers: enforce E.164 format on storage; display in local format based on user's device locale

## Open Questions

1. Should there be a shared team inbox for inbound messages, or are messages always routed to the assigned rep?
2. VoIP calling (calling through the app, no native dialer)? High complexity, defer to v2.
3. Should message history be searchable? (Useful but expensive to implement; use PostgreSQL full-text on message body)
4. Message templates: pre-written messages a rep can send with one tap? (Post-MVP or part of Custom Workflows feature)

## Technical Notes

- Native call: `Linking.openURL('tel:' + phoneNumber)` via expo-linking; app state change to "background" detected via AppState API to know when user is returning from a call
- Message delivery: `POST /messages/in-app` → save to messages table → emit WebSocket event to assigned rep → send push notification if the rep has no active session
- WebSocket: Socket.io room per organization; user joins their org room on login; new messages emit `message.received` event
- Thread pagination: `GET /messages/conversation/:contact_id?page=1&per_page=50` — always newest first
- Phone number validation: `libphonenumber-js` for parsing and E.164 normalization on both mobile client and backend
