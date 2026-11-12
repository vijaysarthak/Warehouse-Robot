"""
environment.py: the warehouse WORLD (in RL words: the "environment").

The robot lives on a grid. Each episode is one customer order:
    1. An order arrives for one of the pick points (P1, P2, ...).
    2. The robot drives to that pick point and does PICK.
    3. It drives to the drop-off (D) and does DROP.  -> episode finished

The environment never tells the robot HOW to do this. It only hands out
rewards (points) after every action. The robot has to learn from those points.

Grid characters:
    .  floor            #  rack (shelf, blocked)
    P  pick point       D  drop-off / packing station
"""

import random
from collections import deque

ACTIONS = ["Up", "Down", "Left", "Right", "Pick", "Drop"]
MOVES = {0: (-1, 0), 1: (1, 0), 2: (0, -1), 3: (0, 1)}   # (row change, column change)
PICK, DROP = 4, 5

DEFAULT_REWARDS = {
    "step": -1,      # every action costs a little time/battery -> prefer short routes
    "bump": -5,      # tried to drive into a rack or the wall
    "wrong": -10,    # PICK or DROP at the wrong place
    "pick": 10,      # picked up the right item
    "deliver": 20,   # delivered it -> order complete
}

PRESETS = {
    "Starter": [
        "P.....",
        ".##.#.",
        ".##.#P",
        "......",
        ".#..#.",
        ".#.D..",
    ],
    "Warehouse": [
        "..........",
        ".##.##.##.",
        "P##.##P##.",
        "..........",
        ".##P##.##.",
        ".##.##.##.",
        "..........",
        ".##.##P##.",
        "P##P##.##.",
        "....D.....",
    ],
    "Maze": [
        ".....#.P",
        ".###.#.#",
        ".#...#..",
        ".#.###.#",
        ".#.....#",
        "P####.##",
        ".....#..",
        ".###...D",
    ],
}

MIN_SIZE, MAX_SIZE, MAX_PICKS = 4, 12, 8


class Warehouse:
    def __init__(self, grid, rewards=None, seed=None):
        self._load_grid(grid)
        self.rewards = {**DEFAULT_REWARDS, **(rewards or {})}
        self.rng = random.Random(seed)
        # Long enough to finish, short enough that a lost robot gives up.
        self.max_steps = max(100, 2 * self.rows * self.cols)

        # Number of different situations ("states") the robot can be in:
        # every cell x every order x carrying-or-not.
        self.n_states = self.rows * self.cols * self.n_orders * 2
        self.n_actions = len(ACTIONS)

        self.pos, self.order, self.carrying, self.steps = (0, 0), 0, False, 0

    # ------------------------------------------------------------------ setup
    def _load_grid(self, grid):
        if not grid or not all(isinstance(r, str) for r in grid):
            raise ValueError("The layout is empty.")
        self.rows, self.cols = len(grid), len(grid[0])
        if any(len(r) != self.cols for r in grid):
            raise ValueError("Every row of the layout must have the same length.")
        if not (MIN_SIZE <= self.rows <= MAX_SIZE and MIN_SIZE <= self.cols <= MAX_SIZE):
            raise ValueError(f"The floor must be between {MIN_SIZE} and {MAX_SIZE} cells wide and tall.")

        self.grid = [list(r) for r in grid]
        self.racks, self.picks, drops = set(), [], []
        for r, row in enumerate(grid):
            for c, ch in enumerate(row):
                if ch == "#":
                    self.racks.add((r, c))
                elif ch == "P":
                    self.picks.append((r, c))
                elif ch == "D":
                    drops.append((r, c))
                elif ch != ".":
                    raise ValueError(f"Unknown character '{ch}' in the layout.")

        if len(drops) != 1:
            raise ValueError("Place exactly one drop-off (D).")
        if not 1 <= len(self.picks) <= MAX_PICKS:
            raise ValueError(f"Place between 1 and {MAX_PICKS} pick points (P).")
        self.drop = drops[0]
        self.n_orders = len(self.picks)
        self.floor = [(r, c) for r in range(self.rows) for c in range(self.cols)
                      if (r, c) not in self.racks]
        for i, p in enumerate(self.picks):
            if self.distance(p, self.drop) is None:
                raise ValueError(f"Pick point P{i + 1} cannot reach the drop-off. Clear a path.")

    # ------------------------------------------------------------- helpers
    def is_free(self, r, c):
        return 0 <= r < self.rows and 0 <= c < self.cols and (r, c) not in self.racks

    def state_id(self, pos, order, carrying):
        """Turn the situation into one number, so it can index the Q-table."""
        r, c = pos
        return ((r * self.cols + c) * self.n_orders + order) * 2 + int(carrying)

    @property
    def target(self):
        """Where the robot should be heading right now."""
        return self.drop if self.carrying else self.picks[self.order]

    def distance(self, a, b):
        """Shortest number of moves from a to b (breadth-first search)."""
        if a == b:
            return 0
        seen, queue = {a}, deque([(a, 0)])
        while queue:
            (r, c), d = queue.popleft()
            for dr, dc in MOVES.values():
                nxt = (r + dr, c + dc)
                if self.is_free(*nxt) and nxt not in seen:
                    if nxt == b:
                        return d + 1
                    seen.add(nxt)
                    queue.append((nxt, d + 1))
        return None

    def best_possible_steps(self, start, order):
        """Perfect score for an order: drive, PICK, drive, DROP."""
        pick = self.picks[order]
        return self.distance(start, pick) + 1 + self.distance(pick, self.drop) + 1

    # ------------------------------------------------------- the RL interface
    def reset(self, order=None, start=None):
        """Start a new order. Returns the starting state."""
        self.order = self.rng.randrange(self.n_orders) if order is None else order
        if start is None:
            options = [p for p in self.floor if p not in (self.drop, self.picks[self.order])]
            start = self.rng.choice(options)
        self.pos, self.carrying, self.steps = tuple(start), False, 0
        return self.state_id(self.pos, self.order, self.carrying)

    def step(self, action):
        """Do one action. Returns (next_state, reward, done, event).

        done = True only when the order is delivered. Running out of time is
        NOT "done" for learning purposes (see README: "time-outs").
        """
        R = self.rewards
        self.steps += 1
        reward, done, event = R["step"], False, "move"

        if action in MOVES:
            dr, dc = MOVES[action]
            nr, nc = self.pos[0] + dr, self.pos[1] + dc
            if self.is_free(nr, nc):
                self.pos = (nr, nc)
            else:
                reward += R["bump"]
                event = "bump"
        elif action == PICK:
            if not self.carrying and self.pos == self.picks[self.order]:
                self.carrying = True
                reward += R["pick"]
                event = "pick"
            else:
                reward += R["wrong"]
                event = "wrong"
        elif action == DROP:
            if self.carrying and self.pos == self.drop:
                reward += R["deliver"]
                self.carrying = False
                done, event = True, "deliver"
            else:
                reward += R["wrong"]
                event = "wrong"

        return self.state_id(self.pos, self.order, self.carrying), reward, done, event

    @property
    def out_of_time(self):
        return self.steps >= self.max_steps
