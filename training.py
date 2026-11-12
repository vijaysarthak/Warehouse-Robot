"""
training.py: the loop that lets the robot practise, plus tests of what it learned.

Run it on its own to train without the web UI:
    python training.py
"""

from agent import QLearningAgent
from environment import ACTIONS, PRESETS, Warehouse


def epsilon_at(episode, planned, start=1.0, end=0.05, decay_share=0.7):
    """Exploration rate for an episode. Starts high (try everything) and falls
    in a straight line to `end` over the first 70% of the planned episodes."""
    decay_episodes = max(1, int(planned * decay_share))
    progress = min(episode / decay_episodes, 1.0)
    return start + progress * (end - start)


def train_one_episode(env, agent, epsilon):
    """Play one order from start to finish, learning after every action."""
    state = env.reset()
    total, done = 0, False
    path = [[*env.pos, 0]]                  # [row, col, carrying] for the UI's route
    while not done and not env.out_of_time:
        action, _ = agent.choose_action(state, epsilon)
        next_state, reward, done, _ = env.step(action)
        agent.learn(state, action, reward, next_state, done)
        state, total = next_state, total + reward
        path.append([*env.pos, int(env.carrying)])
    return {"reward": total, "steps": env.steps, "success": done, "path": path}


def deliver(env, agent, order=None, start=None):
    """Use what the robot learned (no exploring, no learning) and record every
    step, so the UI can replay it."""
    state = env.reset(order=order, start=start)
    best = env.best_possible_steps(env.pos, env.order)
    frames = [{"pos": list(env.pos), "carrying": False, "action": None,
               "reward": 0, "event": "start"}]
    done = False
    while not done and not env.out_of_time:
        action = agent.best_action(state)
        state, reward, done, event = env.step(action)
        frames.append({"pos": list(env.pos), "carrying": env.carrying,
                       "action": ACTIONS[action], "reward": reward, "event": event})
    return {"order": env.order, "success": done, "steps": env.steps,
            "best_possible": best, "frames": frames}


def test_robot(env, agent, orders=100, seed=12345):
    """Run many orders with the learned behaviour and summarise.
    Efficiency = best possible steps / steps used (100% = perfect routes)."""
    env.rng.seed(seed)           # same test orders every time -> fair comparison
    results = [deliver(env, agent) for _ in range(orders)]
    ok = [r for r in results if r["success"]]
    return {
        "orders": orders,
        "success_rate": len(ok) / orders,
        "avg_steps": sum(r["steps"] for r in ok) / len(ok) if ok else None,
        "avg_best": sum(r["best_possible"] for r in ok) / len(ok) if ok else None,
        "efficiency": (sum(r["best_possible"] / r["steps"] for r in ok) / len(ok)) if ok else 0.0,
    }


if __name__ == "__main__":
    env = Warehouse(PRESETS["Warehouse"], seed=0)
    agent = QLearningAgent(env.n_states, env.n_actions, alpha=0.2, gamma=0.95, seed=0)
    planned = 3000
    window = []
    print(f"{env.rows}x{env.cols} warehouse, {env.n_orders} pick points, "
          f"{env.n_states} states x {env.n_actions} actions")
    for ep in range(planned):
        result = train_one_episode(env, agent, epsilon_at(ep, planned))
        window = (window + [result])[-300:]
        if (ep + 1) % 300 == 0:
            wins = sum(r["success"] for r in window) / len(window)
            avg = sum(r["reward"] for r in window) / len(window)
            print(f"episode {ep + 1:5d}  epsilon {epsilon_at(ep, planned):.2f}  "
                  f"avg reward {avg:8.1f}  success {wins:6.1%}")
    print("test on 100 new orders:", test_robot(env, agent))
