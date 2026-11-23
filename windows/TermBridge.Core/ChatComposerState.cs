namespace TermBridge.Core;

/// <summary>One host/session's draft and delivery, independent of the visible view.</summary>
public sealed class ChatComposerState {
    private string draft="";
    private bool restoredDraft;
    public string Draft { get=>draft; set{draft=value;restoredDraft=false;} }
    public string? RequestId { get; private set; }
    public string? SubmittedText { get; private set; }
    public int Generation { get; private set; }
    public string State { get; private set; } = "idle";
    public string? Detail { get; private set; }
    public bool Pending => State is "accepted" or "delivered";
    public bool Retryable => State == "failed" && SubmittedText != null;

    public void Begin(string requestId, string text, int generation) {
        RequestId=requestId;SubmittedText=text;Generation=generation;
        State="accepted";Detail=null;Draft="";
    }

    public bool Apply(string requestId,int generation,string state,string? detail=null) {
        if(RequestId!=requestId||Generation!=generation)return false;
        if(state is not ("accepted" or "delivered" or "observed" or "failed" or "uncertain"))return false;
        // Late intermediate receipts cannot turn a finished send back into a spinner.
        if(!Pending && (state is "accepted" or "delivered"))return false;
        if(State=="observed")return false;
        State=state;Detail=detail;
        if(state=="observed"){
            if(restoredDraft&&draft==SubmittedText)draft="";
            restoredDraft=false;SubmittedText=null;
        }
        else if(state is "failed" or "uncertain")RestoreDraft();
        return true;
    }

    public void LoseConfirmation(string detail) {
        if(!Pending)return;
        State="uncertain";Detail=detail;RestoreDraft();
    }

    private void RestoreDraft() {
        if(draft.Length==0 && SubmittedText is {} text){draft=text;restoredDraft=true;}
    }
}
