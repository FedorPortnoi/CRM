---
tags: [feature, mvp, calling, sms, messaging, communication]
status: specced
related: ["Contact Management", "Interaction History", "Auto Information Capture", "Smart Data Entry", "Task Management"]
created: 2026-05-01
---

# Call & Messaging

## Overview

Reach out to customers directly from within the CRM without switching tools. Every time a salesperson leaves the CRM to make a call or send a message, there is a ~70% chance they won't log it afterward. Keeping communication inside the app ensures everything is captured automatically.

One-tap calling uses the device's native phone dialer (no VoIP for MVP). After the call, the app prompts for notes and auto-logs the call. SMS via Twilio; in-app messaging via WebSocket. All automatically fed to [[Interaction History]] via [[Auto Information Capture]].

## Why It Matters

Tool-switching kills logging. The most valuable thing this feature does is not the calling itself — it's ensuring every communication is recorded. A contact's [[Interaction History]] is only as good as the data that goes into it. By making calls and messages happen inside the CRM, logging becomes automatic rather than aspirational.

## User Stories

- As a sales rep, I want to tap a contact's phone number and start a call so I don't switch apps
- As a sales rep, I want the app to prompt me for call notes immediately after hanging up so context is captured while fresh
- As a customer success manager, I want to send SMS from the contact profile so I don't switch to my phone messaging app
- As a sales rep, I want a push notification when a customer replies to my SMS so I respond quickly
- As a manager, I want to see all calls and messages a rep had with a contact this week for handoff review
- As a team member, I want messages auto-logged to contact history so I don't enter them manually

## Acceptance Criteria

- One-tap call: `tel://` deep link via `Linking.openURL` → native phone dialer
- Post-call prompt: on app foreground after a call, show "Add notes?" with estimated duration pre-filled
- Outbound SMS via Twilio from contact profile; sender is org's Twilio number
- Inbound SMS: Twilio webhook → saved to messages table → real-time push notification to assigned rep
- In-app messaging: WebSocket delivery if contact has app
- All sent/received messages auto-logged to activity_log (via [[Auto Information Capture]])
- Unread badge on Messages tab and contact list items
- Message thread view: chronological conversation, both SMS and in-app in one thread

## Technical Notes

- Native call: `Linking.openURL('tel:+1...')` via expo-linking
- Return-from-call detection: AppState listener fires 'active' → compute elapsed time → prompt
- Twilio inbound webhook: `POST /webhooks/twilio/inbound` → validate Twilio signature → save message → emit WebSocket `message.received` → push notification
- WebSocket: Socket.io room per organization; join on login; events: `message.received`, `message.status`
- Phone number normalization: `libphonenumber-js` → E.164 format

## Related Features

- [[Contact Management]] — calls/messages initiated from contact profile
- [[Interaction History]] — all calls/messages appear in contact timeline
- [[Auto Information Capture]] — automatic logging engine for calls and messages
- [[Smart Data Entry]] — voice notes for quick contact data entry
- [[Task Management]] — follow-up task creation post-call

## Open Questions

1. Should we support WhatsApp at MVP? (Proposed: no — SMS + in-app for MVP)
2. Shared team inbox for inbound messages, or routed to assigned rep only?
3. VoIP calling (in-app telephony via Twilio Voice SDK)? (Proposed: v2)
4. Message templates for quick sending? (Part of [[Custom Workflows]] or post-MVP)
5. International phone numbers — how do we handle numbers that Twilio can't SMS?
