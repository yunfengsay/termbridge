package com.termbridge.android.review;

import io.noties.prism4j.annotations.PrismBundle;

@PrismBundle(
        grammarLocatorClassName = "com.termbridge.android.review.ReviewGrammarLocator",
        include = {
                "c", "cpp", "csharp", "css", "dart", "git", "go", "groovy", "java",
                "javascript", "json", "kotlin", "makefile", "markdown", "markup", "python",
                "scala", "sql", "swift", "yaml"
        }
)
public final class ReviewPrismBundle {
    private ReviewPrismBundle() {}
}
