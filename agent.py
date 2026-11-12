r"""
agent.py: the robot's BRAIN (in RL words: the "agent").

The brain is a Q-table: one row per state, one number per action.

    Q[state][action] = "how many points I expect to collect from here on
                        if I take this action now and act well afterwards"

At the start every number is 0 (the robot knows nothing). After each action
the robot nudges one number towards what it just experienced:

    Q[s][a]  <-  Q[s][a] + alpha * ( reward + gamma * max(Q[s'])  -  Q[s][a] )
                                     \_______ target ___________/
                                   \___________ TD error ___________________/
"""

import random


class QLearningAgent:
    def __init__(self, n_states, n_actions, alpha=0.1, gamma=0.95, seed=None):
        self.alpha = alpha      # learning rate: how big each nudge is (0..1)
        self.gamma = gamma      # discount: how much future points matter (0..1)
        self.n_actions = n_actions
        self.q = [[0.0] * n_actions for _ in range(n_states)]
        self.rng = random.Random(seed)

    def best_action(self, state):
        """The action with the highest Q-value. Ties are broken at random,
        otherwise an untrained robot would always pick action 0 (Up)."""
        row = self.q[state]
        top = max(row)
        return self.rng.choice([a for a, v in enumerate(row) if v == top])

    def choose_action(self, state, epsilon):
        """Epsilon-greedy: with probability epsilon try something random
        (EXPLORE), otherwise use the best known action (EXPLOIT)."""
        if self.rng.random() < epsilon:
            return self.rng.randrange(self.n_actions), "explore"
        return self.best_action(state), "exploit"

    def learn(self, state, action, reward, next_state, done):
        """One Q-learning update. Returns every number involved, so the UI can
        show the calculation step by step."""
        old = self.q[state][action]
        best_next = 0.0 if done else max(self.q[next_state])   # no future after delivery
        target = reward + self.gamma * best_next
        td_error = target - old
        self.q[state][action] = old + self.alpha * td_error
        return {
            "q_old": old,
            "best_next": best_next,
            "target": target,
            "td_error": td_error,
            "q_new": self.q[state][action],
        }

    # ---- save / load the brain as plain JSON-friendly data ----------------
    def to_dict(self):
        return {"alpha": self.alpha, "gamma": self.gamma, "q": self.q}

    @classmethod
    def from_dict(cls, data):
        q = data["q"]
        agent = cls(len(q), len(q[0]), data["alpha"], data["gamma"])
        agent.q = [[float(v) for v in row] for row in q]
        return agent
