const STATE_LABELS = {
  not_joined: "Not joined",
  waiting: "Waiting",
  working: "Working",
  not_responding:
    "Not responding. It may be out of allowance, so check its app.",
};

const elements = {
  room: document.querySelector("#room"),
  notice: document.querySelector("#notice"),
  messages: document.querySelector("#messages"),
  agents: document.querySelector("#agents"),
  body: document.querySelector("#body"),
  send: document.querySelector("#send"),
};

let displayNames = {};
let lastMessageId = 0;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatTime(timestamp) {
  return timestamp ? new Date(timestamp).toLocaleTimeString() : "None";
}

function formatDuration(ms) {
  if (!ms) return "0s";
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function renderMessages(messages) {
  const newest = messages.at(-1)?.id ?? 0;
  if (newest === lastMessageId) return;
  const shouldScroll =
    elements.messages.scrollHeight -
      elements.messages.scrollTop -
      elements.messages.clientHeight <
    80;
  elements.messages.replaceChildren(
    ...messages.map((message) => {
      const item = element("li");
      const sender =
        message.sender_type === "user"
          ? "You"
          : (displayNames[message.sender_id] ?? message.sender_id);
      item.append(
        element("span", "sender", sender),
        element("span", "time", formatTime(message.created_at)),
        element("p", "body", message.body),
      );
      return item;
    }),
  );
  lastMessageId = newest;
  if (shouldScroll)
    elements.messages.scrollTop = elements.messages.scrollHeight;
}

function statRow(list, label, value) {
  list.append(element("dt", "", label), element("dd", "", value));
}

function renderAgents(agents) {
  elements.agents.replaceChildren(
    ...agents.map((agent) => {
      const box = element("div", "agent");
      box.append(
        element("h3", "", agent.display_name),
        element("p", "state", STATE_LABELS[agent.state]),
      );
      const stats = element("dl");
      statRow(stats, "Model wait calls", String(agent.stats.model_wait_calls));
      statRow(
        stats,
        "Calls per hour",
        agent.stats.calls_per_hour === null
          ? "None"
          : agent.stats.calls_per_hour.toFixed(1),
      );
      statRow(stats, "Longest gap", formatDuration(agent.stats.longest_gap_ms));
      statRow(stats, "Joined", formatTime(agent.stats.session_started_at));
      statRow(
        stats,
        "Last wait call",
        formatTime(agent.stats.last_wait_call_at),
      );
      statRow(stats, "Rejoins", String(agent.stats.rejoins));
      statRow(stats, "Turns completed", String(agent.stats.turns_completed));
      statRow(stats, "Turns skipped", String(agent.stats.turns_skipped));
      const copy = element("button", "", "Copy join prompt");
      copy.type = "button";
      copy.addEventListener("click", async () => {
        await navigator.clipboard.writeText(agent.join_prompt);
        copy.textContent = "Copied";
        setTimeout(() => (copy.textContent = "Copy join prompt"), 1500);
      });
      box.append(stats, copy);
      return box;
    }),
  );
}

async function refresh() {
  const response = await fetch("/api/state");
  if (!response.ok) throw new Error(`State request failed: ${response.status}`);
  const state = await response.json();
  displayNames = Object.fromEntries(
    state.agents.map((agent) => [agent.id, agent.display_name]),
  );
  elements.room.textContent = `#${state.room.name}: ${state.room.topic}`;
  const limited = state.room.agent_streak >= state.room.streak_limit;
  elements.notice.hidden = !limited;
  elements.notice.textContent = limited
    ? `Agents have posted ${state.room.agent_streak} messages in a row. Post a message to continue.`
    : "";
  renderMessages(state.messages);
  renderAgents(state.agents);
}

async function send() {
  const body = elements.body.value;
  if (!body.trim()) return;
  elements.send.disabled = true;
  try {
    const response = await fetch("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message);
    }
    elements.body.value = "";
    await refresh();
  } catch (error) {
    elements.notice.hidden = false;
    elements.notice.textContent = `Message not sent: ${error.message}`;
  } finally {
    elements.send.disabled = false;
    elements.body.focus();
  }
}

elements.send.addEventListener("click", send);
elements.body.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) send();
});

new EventSource("/api/events").onmessage = () => refresh().catch(console.error);
setInterval(() => refresh().catch(console.error), 10000);
refresh().catch(console.error);
