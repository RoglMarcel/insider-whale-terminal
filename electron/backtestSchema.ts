/** Append-only evidence survives portfolio resets and source pruning. */
export const BACKTEST_SCHEMA = `
CREATE TABLE IF NOT EXISTS backtest_decisions (key TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS backtest_purchases (key TEXT PRIMARY KEY, portfolio TEXT NOT NULL, portfolio_id TEXT NOT NULL, strategy TEXT NOT NULL, snapshot TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS backtest_trades (key TEXT PRIMARY KEY, purchase_key TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS backtest_analyses (key TEXT PRIMARY KEY, purchase_key TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS backtest_closures (key TEXT PRIMARY KEY, purchase_key TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS backtest_replays (key TEXT PRIMARY KEY, purchase_key TEXT NOT NULL, payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_backtest_trades ON backtest_trades(purchase_key);
CREATE INDEX IF NOT EXISTS idx_backtest_analyses ON backtest_analyses(purchase_key);
CREATE TRIGGER IF NOT EXISTS backtest_decisions_immutable BEFORE UPDATE ON backtest_decisions BEGIN SELECT RAISE(ABORT, 'immutable decision'); END;
CREATE TRIGGER IF NOT EXISTS backtest_purchases_immutable BEFORE UPDATE ON backtest_purchases BEGIN SELECT RAISE(ABORT, 'immutable purchase'); END;
CREATE TRIGGER IF NOT EXISTS backtest_trades_immutable BEFORE UPDATE ON backtest_trades BEGIN SELECT RAISE(ABORT, 'immutable trade'); END;
CREATE TRIGGER IF NOT EXISTS backtest_analyses_immutable BEFORE UPDATE ON backtest_analyses BEGIN SELECT RAISE(ABORT, 'immutable analysis'); END;
CREATE TRIGGER IF NOT EXISTS backtest_closures_immutable BEFORE UPDATE ON backtest_closures BEGIN SELECT RAISE(ABORT, 'immutable closure'); END;
CREATE TRIGGER IF NOT EXISTS backtest_decisions_no_delete BEFORE DELETE ON backtest_decisions BEGIN SELECT RAISE(ABORT, 'immutable decision'); END;
CREATE TRIGGER IF NOT EXISTS backtest_purchases_no_delete BEFORE DELETE ON backtest_purchases BEGIN SELECT RAISE(ABORT, 'immutable purchase'); END;
CREATE TRIGGER IF NOT EXISTS backtest_trades_no_delete BEFORE DELETE ON backtest_trades BEGIN SELECT RAISE(ABORT, 'immutable trade'); END;
CREATE TRIGGER IF NOT EXISTS backtest_analyses_no_delete BEFORE DELETE ON backtest_analyses BEGIN SELECT RAISE(ABORT, 'immutable analysis'); END;
CREATE TRIGGER IF NOT EXISTS backtest_closures_no_delete BEFORE DELETE ON backtest_closures BEGIN SELECT RAISE(ABORT, 'immutable closure'); END;
`;
