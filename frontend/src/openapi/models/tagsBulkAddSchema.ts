/**
 * Generated by Orval
 * Do not edit manually.
 * See `gen:api` script in package.json
 */
import type { UpdateTagsSchema } from './updateTagsSchema';

/**
 * Represents tag changes to be applied to a list of features.
 */
export interface TagsBulkAddSchema {
    /** The list of features that will be affected by the tag changes. */
    features: string[];
    /** The tag changes to be applied to the features. */
    tags: UpdateTagsSchema;
}
