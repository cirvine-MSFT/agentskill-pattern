export class FiniteDomainSolver {
  constructor(domains) {
    this.variables = Object.keys(domains);
    this.domains = domains;
    this.constraints = [];
  }

  addConstraint(variables, predicate) {
    this.constraints.push({ variables, predicate });
    return this;
  }

  solve(limit = Infinity) {
    const solutions = [];
    const assignment = {};

    const search = (index) => {
      if (solutions.length >= limit) return;
      if (index === this.variables.length) {
        solutions.push({ ...assignment });
        return;
      }
      const variable = this.variables[index];
      for (const value of this.domains[variable]) {
        assignment[variable] = value;
        const viable = this.constraints.every((constraint) => {
          if (!constraint.variables.every((name) => name in assignment)) return true;
          return constraint.predicate(assignment);
        });
        if (viable) search(index + 1);
        delete assignment[variable];
      }
    };

    search(0);
    return solutions;
  }
}
