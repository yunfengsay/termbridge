package com.termbridge.android.review;

import io.noties.markwon.syntax.Prism4jSyntaxHighlight;
import io.noties.markwon.syntax.Prism4jThemeDarkula;
import io.noties.markwon.syntax.Prism4jThemeDefault;
import io.noties.prism4j.Prism4j;

public final class ReviewPrismFactory {
    private ReviewPrismFactory() {}

    public static Prism4jSyntaxHighlight create(boolean dark) {
        return Prism4jSyntaxHighlight.create(
                new Prism4j(new ReviewGrammarLocator()),
                dark ? Prism4jThemeDarkula.create() : Prism4jThemeDefault.create()
        );
    }
}
