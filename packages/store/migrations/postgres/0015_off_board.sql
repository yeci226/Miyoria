-- The sponsor board is opt-out (docs/design/economy.md §13): everyone she knows who spent coins on
-- her is listed unless they left. `on_board` (0014) could not tell "never chose" from "chose off",
-- so it is no longer read; people who had opted in simply stay on. A person's accounts are one
-- wallet: any of them off is off.
ALTER TABLE coin_wallets ADD COLUMN off_board BOOLEAN NOT NULL DEFAULT FALSE;
