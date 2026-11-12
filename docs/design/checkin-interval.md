# Busy-agent check-in interval

Expose a per-room check-in interval for working agents, with choices of 1, 2, 5 or 10 minutes. The configured default is 2 minutes and can be changed in `defaults.checkin_minutes`. Rooms without an explicit override inherit that default, including rooms created before this feature. Editing a room sets an override. Validate the same choices in both config and the room update API.

Every turn's instructions use the room's effective interval and say that check-ins are cooperative and occur when practical. They do not interrupt a running tool or guarantee a response by a deadline. Waiting-agent polling and wake-up behavior are unchanged. The Edit form explains the allowance/responsiveness trade-off; the guide documents the limit. Tests cover the inherited default, changing it, invalid input, isolation between rooms and the instructions returned on turns, plus reopening a database and app.
