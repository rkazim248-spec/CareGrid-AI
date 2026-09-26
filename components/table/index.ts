/**
 * Public barrel for the table primitives.
 *
 * `DataTable` is the generic admin table. The incident queue and the history
 * table are NOT here: they need a fixed column set, a `scope="row"` reference
 * cell, exactly one `aria-sort`, and a card-list variant below 768px, so they
 * live with their features where a reviewer can see the whole row contract in
 * one file.
 */
export { DataTable } from './data-table';
