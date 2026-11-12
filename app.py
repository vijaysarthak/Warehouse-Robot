"""
app.py: a small web server that connects the browser UI to the robot.

Start it with:
    python app.py
then open http://localhost:8000  (API docs: http://localhost:8000/docs)

The browser never does any learning itself. Every button press calls one of
the /api/... routes below, and Python does the work.
"""

import threading
from pathlib import Path
from typing import Optional

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from agent import QLearningAgent
from environment import ACTIONS, DEFAULT_REWARDS, PRESETS, Warehouse
from training import deliver, epsilon_at, test_robot, train_one_episode

HERE = Path(__file__).parent
app = FastAPI(title="Warehouse Robot Lab", version="1.0")
app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")


# --------------------------------------------------------------------------
# The "lab": one warehouse + one robot brain, kept in memory while the
# server runs. (One user at a time, which is all a demo needs.)
# --------------------------------------------------------------------------
class Lab:
    def __init__(self):
        self.lock = threading.Lock()
        self.env = None          # world used for training
        self.step_env = None     # separate world for the step-by-step view
        self.agent = None
        self.settings = None
        self.episode = 0
        self.step_active = False
        self.history = []        # one entry per practice order, so a page refresh keeps the charts

    def epsilon(self):
        s = self.settings
        return epsilon_at(self.episode, s.episodes, s.epsilon_start, s.epsilon_end)

    def q_rounded(self):
        return [[round(v, 2) for v in row] for row in self.agent.q]


lab = Lab()


# ------------------------------------------------------------ request shapes
class Rewards(BaseModel):
    step: float = Field(DEFAULT_REWARDS["step"], ge=-20, le=0)
    bump: float = Field(DEFAULT_REWARDS["bump"], ge=-50, le=0)
    wrong: float = Field(DEFAULT_REWARDS["wrong"], ge=-50, le=0)
    pick: float = Field(DEFAULT_REWARDS["pick"], ge=0, le=100)
    deliver: float = Field(DEFAULT_REWARDS["deliver"], ge=0, le=200)


class Settings(BaseModel):
    grid: list[str]
    alpha: float = Field(0.2, gt=0, le=1)
    gamma: float = Field(0.95, ge=0, le=0.999)
    epsilon_start: float = Field(1.0, ge=0, le=1)
    epsilon_end: float = Field(0.05, ge=0, le=1)
    episodes: int = Field(3000, ge=50, le=50000)
    rewards: Rewards = Rewards()
    seed: Optional[int] = None


class TrainRequest(BaseModel):
    episodes: int = Field(10, ge=1, le=1000)


class DeliverRequest(BaseModel):
    order: Optional[int] = None
    start: Optional[list[int]] = None


class BrainFile(BaseModel):
    settings: Settings
    episode: int
    brain: dict


def require_lab():
    if lab.agent is None:
        raise HTTPException(409, "Set up the warehouse first: press Start training.")


def snapshot(extra=None):
    """Everything the UI needs to redraw itself."""
    env = lab.env
    data = {
        "rows": env.rows, "cols": env.cols, "grid": ["".join(r) for r in env.grid],
        "picks": [list(p) for p in env.picks], "drop": list(env.drop),
        "n_orders": env.n_orders, "n_states": env.n_states, "actions": ACTIONS,
        "episode": lab.episode, "planned": lab.settings.episodes,
        "epsilon": lab.epsilon(), "q": lab.q_rounded(),
        "settings": lab.settings.model_dump(),
    }
    data.update(extra or {})
    return data


# ------------------------------------------------------------------ routes
@app.get("/")
def home():
    return FileResponse(HERE / "static" / "index.html")


@app.get("/api/presets")
def presets():
    return {"presets": PRESETS, "rewards": DEFAULT_REWARDS}


@app.get("/api/state")
def state():
    """Lets the page pick up where it left off after a refresh."""
    if lab.agent is None:
        return {"ready": False}
    with lab.lock:
        return {"ready": True, **snapshot({"history": lab.history})}


@app.post("/api/setup")
def setup(settings: Settings):
    """Build the warehouse and a brand-new (empty) robot brain."""
    try:
        env = Warehouse(settings.grid, settings.rewards.model_dump(), settings.seed)
    except ValueError as e:
        raise HTTPException(400, str(e))
    with lab.lock:
        lab.env = env
        lab.step_env = Warehouse(settings.grid, settings.rewards.model_dump(), settings.seed)
        lab.agent = QLearningAgent(env.n_states, env.n_actions, settings.alpha,
                                   settings.gamma, settings.seed)
        lab.settings, lab.episode, lab.step_active = settings, 0, False
        lab.history = []
        return snapshot()


@app.post("/api/train")
def train(req: TrainRequest):
    """Practise for a few more episodes and report how they went."""
    require_lab()
    with lab.lock:
        history, last = [], None
        for _ in range(req.episodes):
            eps = lab.epsilon()
            last = train_one_episode(lab.env, lab.agent, eps)
            lab.episode += 1
            history.append({"episode": lab.episode, "reward": last["reward"],
                            "steps": last["steps"], "success": last["success"],
                            "epsilon": round(eps, 4)})
        lab.history.extend(history)
        return snapshot({"history": history, "last_path": last["path"],
                         "last_success": last["success"]})


@app.post("/api/step")
def step():
    """One single action with the full Q-learning calculation, for teaching."""
    require_lab()
    with lab.lock:
        env, agent = lab.step_env, lab.agent
        if not lab.step_active:
            env.reset()
            lab.step_active = True
        state = env.state_id(env.pos, env.order, env.carrying)
        before = {"pos": list(env.pos), "carrying": env.carrying}
        q_before = list(agent.q[state])
        eps = lab.epsilon()

        action, how = agent.choose_action(state, eps)
        next_state, reward, done, event = env.step(action)
        maths = agent.learn(state, action, reward, next_state, done)

        finished = done or env.out_of_time
        if finished:
            lab.step_active = False
        return {
            "before": before, "after": {"pos": list(env.pos), "carrying": env.carrying},
            "order": env.order, "target": list(env.picks[env.order]), "drop": list(env.drop),
            "state": state, "next_state": next_state,
            "action": ACTIONS[action], "action_index": action, "how": how,
            "epsilon": eps, "reward": reward, "event": event,
            "alpha": agent.alpha, "gamma": agent.gamma, **maths,
            "q_before": q_before, "q_after": list(agent.q[state]),
            "q_next": list(agent.q[next_state]),
            "done": done, "timed_out": env.out_of_time and not done,
            "finished": finished, "steps": env.steps,
        }


@app.post("/api/step/reset")
def step_reset():
    require_lab()
    with lab.lock:
        lab.step_active = False
        return {"ok": True}


@app.post("/api/deliver")
def deliver_order(req: DeliverRequest):
    """Watch the trained robot handle one order using only what it learned."""
    require_lab()
    with lab.lock:
        env = lab.env
        if req.order is not None and not 0 <= req.order < env.n_orders:
            raise HTTPException(400, "That pick point does not exist.")
        start = None
        if req.start is not None:
            start = tuple(req.start)
            if not env.is_free(*start):
                raise HTTPException(400, "The robot must start on a floor cell, not a rack.")
        return deliver(env, lab.agent, req.order, start)


@app.post("/api/test")
def test():
    """100 orders, no exploring, no learning: how good is the robot really?"""
    require_lab()
    with lab.lock:
        return test_robot(lab.env, lab.agent, orders=100)


@app.get("/api/brain")
def download_brain():
    require_lab()
    with lab.lock:
        return {"settings": lab.settings.model_dump(), "episode": lab.episode,
                "brain": lab.agent.to_dict()}


@app.post("/api/brain")
def upload_brain(file: BrainFile):
    data = setup(file.settings)  # rebuilds the warehouse, validates the layout
    with lab.lock:
        q = file.brain.get("q")
        if not q or len(q) != lab.env.n_states or len(q[0]) != lab.env.n_actions:
            raise HTTPException(400, "This brain file does not match its warehouse layout.")
        lab.agent = QLearningAgent.from_dict(file.brain)
        lab.episode = file.episode
        return snapshot()


if __name__ == "__main__":
    print("\n  Warehouse Robot Lab is running: open http://localhost:8000\n")
    uvicorn.run(app, host="127.0.0.1", port=8000)
