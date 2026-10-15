Feature: Switch a running client between worktrees without restarting it

  A client holds one fixed address. Each worktree keeps its own server
  warm on its own port, and the portful proxy on the fixed port forwards
  to whichever worktree is active. portful use flips the active worktree,
  and the client's next request lands there with nothing restarted.

  Scenario: the fixed port follows portful use on the next request
    Given a repository with worktrees "feature-x" and "feature-y" registered with portful
    And portful serves "feature-x" and "feature-y", each on its own port
    And the portful proxy holds the repository's fixed port
    When the agent runs portful use for "feature-x"
    Then a request to the fixed port is answered by "feature-x"
    When the agent runs portful use for "feature-y"
    Then a request to the fixed port is answered by "feature-y"
